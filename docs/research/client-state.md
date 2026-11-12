# Состояние клиента: `useSyncExternalStore`, контексты и варианты кэша

Дата: 2026-10-31. База: `9c54794` (+ FF `82c6ed9`). Историческое техническое исследование,
не план миграции и не источник требований к UI; актуальные правила — в `../engineering.md`.
Пометки: **[S]** — проверено по официальному источнику/исходнику (ссылка рядом), **[I]** — вывод из механизма, в рантайме Corral не проверялся. Замеров производительности не делалось: «нет селекторов» — это ограничение, а не измеренный дефект.

---

## 1. Что чем является

`useSyncExternalStore(subscribe, getSnapshot)` — только примитив подписки: React зовёт `getSnapshot` и перерисовывает, если `Object.is` изменился. Он не загружает, не кэширует по ключу, не дедуплицирует запросы. Требования: иммутабельный снимок, повторные вызовы `getSnapshot` при неизменном сторе возвращают **тот же** объект, `subscribe` — вне компонента; мутация стора во время Transition откатывает апдейт в блокирующий; **не рекомендуется** suspending рендер по этому значению [S: react.dev/reference/react/useSyncExternalStore].

Data fetching (Query/SWR) — ключевой кэш с жизненным циклом (stale/gc/retry/cancel), где `queryFn` — владелец загрузки. Context — транспорт/DI: передаёт значение по дереву, но не даёт адресации по ключу, инвалидации и дедупликации [S: react.dev/learn/passing-data-deeply-with-context].

«Библиотека прячет хук» — не критерий: `@tanstack/react-query@5.105.0` вызывает его в `useBaseQuery` [S: packages/react-query/src/useBaseQuery.ts:108-112], Zustand 5.0.16 — в `esm/react.mjs:6`, Jotai 3.0.1 — в `dist/react/useAtomValueRawSync.js:14` [S: тарболлы npm, 2026-10-31]. Различать надо владение жизненным циклом и адресацию, а не наличие хука.

React Compiler «пропускает оптимизацию, а не ломает поведение»; главный класс поломок — код, полагающийся на мемоизацию для корректности (эффекты от ссылочного равенства) [S: react.dev/learn/react-compiler/debugging]. Поэтому `subscribe`/`getSnapshot` остаются стабильными, а селекторы — мемоизированными; компилятор не отменяет «каждый yield — новый массив», потому что вход действительно меняется [S: react.dev/reference/rules].

React 19.2: `<Activity mode="hidden">` **размонтирует эффекты** [S: react.dev/blog/2025/10/01/react-19-2]. Сейчас `Activity` в Corral не используется — это будущее ограничение, не блокер. Важно лишь как свойство: подписка `useSyncExternalStore` умирает вместе с эффектом.

---

## 2. Что именно принадлежит кому в Corral

Три разных вида состояния, которые нельзя валить в один слой:

1. **DI/контекст:** `CorralClientProvider` (чистый DI), `DialogFocusProvider` (refs). Не данные.
2. **Серверные снапшоты через push:** `projects`, `tasks`, `sessions`, `terminals`, **и `config`**. `config` — такой же watch-кэш: `createConfigStore` строит `createWatchStore` над `config.watch` и заворачивает одно состояние в одноэлементный список (`packages/client/src/config-store.ts:31-59`). Контекст `config` (`apps/web/src/app/providers.tsx:9`, `modules/keymap/config-context.tsx`) — только распространение уже полученного снапшота, а не отдельный кэш.
3. **Транспортные наблюдаемые и UI-временное:** `connection.state` и `TerminalStream.#state` — оба на одном генерическом `Store` (`packages/client/src/store.ts:7-27`, `terminal-stream.ts:45`, `modules/connection/client-context.tsx:23-29`); плюс `useState`/refs для диалогов и режима префикса.

Следствие: `store.ts` — общий примитив транспорта и терминала. «Удалить базовый Store» и «не трогать терминал/транспорт» несовместимы; удалять можно только **доменные** данные (проекции watch'ей), а `Store`, `TerminalStream`, `ReconnectingSocket` и состояние соединения остаются.

Дедупликация сети: `client.projects/tasks/...` — по одному экземпляру на клиент, `watch-store` стартует один вызов на домен (`watch-store.ts:22-51`). Board подписывается на те же объекты (`board-screen.tsx:17-23`), т.е. дублируется **React-проводка и построение дерева**, а не RPC-watch. Экономия от ключевого кэша здесь — не «убрать второй watch», а «убрать вторую подписку/деривацию».

---

## 3. Владение: четыре варианта, честно

```
A. как сейчас: watch-store (app-lifetime) ──► Store<Snapshot> ──► useSyncExternalStore
Z. zustand/vanilla: watch-loop (ваш, app-lifetime) ──► createStore ──► useStore(api, selector)
B. keeper + queryFn: QueryObserver(вне React) ──► queryFn: for await watch ──► setQueryData(key, chunk)
                                                     Query: retry/backoff/status/cancel/keys/select/sharing
C. ingest без queryFn: watch-loop (ваш) ──► setQueryData(key, snapshot)
                                          Query: keys/select/sharing/уведомления; retry/error/cancel — ваши
```

**A. Текущая схема.** Жизненный цикл: `follow()` перезапускается по событию соединения (`watch-store.ts:41-51`); поток не отменяется никогда — в коде прямо сказано, что abort отправляет cancel-сообщение, которое падает на закрытом сокете необработанной ошибкой (`watch-store.ts:17-21`). Это ограничение WS-линка, а не лень: `LinkWebsocketClient.call(request, _options, …)` игнорирует `signal` [S: @orpc/client 1.16.1, dist/adapters/websocket/index.mjs], а остановка идёт через `iterator.return()` [S: orpc.dev/docs/client/async-iterator-object].
Реальный дефект: при ошибке watch `watching` не сбрасывается, пока жив сокет → повторного `follow()` не будет, данные остаются старыми без индикации (`watch-store.ts:29-49`). Это корректностный баг уровня «тикет», а не аргумент за миграцию.

**Z. Zustand vanilla вместо `Store`.** `createStore<Snapshot>(initial)` на домен (или один стор со срезами) заменяет `packages/client/src/store.ts`, а не надстраивает его: watch-loop остаётся вашим и app-lifetime, второго кэша нет. Vanilla API: `{getState, getInitialState, setState, subscribe}`, `setState(partial, replace)` — merge по умолчанию, `replace` для полного снапшота, слушатели получают `(state, prevState)` [S: zustand 5.0.16, esm/vanilla.mjs]. React: `useStore(api, selector)` = `useSyncExternalStore(api.subscribe, useCallback(() => selector(api.getState()), [api, selector]))` [S: esm/react.mjs], т.е. 10 ручных обвязок и `Object.is`-на-всём-снапшоте исчезают; не-React потребители (тесты, мобильный) берут `getState`/`subscribe`, а `subscribeWithSelector` даёт подписку на срез с `equalityFn`/`fireImmediately` [S: esm/middleware/subscribeWithSelector.d.mts]. Merge даёт изоляцию срезов: `setState({tasks})` не меняет ссылку `projects`, подписчики проектов не перерисовываются. `react-native`-условие есть в `exports` [S: package.json].
Что Z **не** решает: retry/error/статус watch — их пишете вы (как в C); структурного шаринга нет — результат селектора сравнивается `Object.is`, поэтому инлайновый селектор, строящий объект/массив, даёт новую ссылку (предупреждение «getSnapshot should be cached»), нужен `useShallow` [S: esm/react/shallow.mjs]; строки из JSON-снапшота каждый yield новые, поэтому «изменилась одна задача → перерисовались все строки» остаётся, пока вы сами не нормализуете строки по id; ключей и дедупликации между доменами, gc и жизненного цикла запроса нет — это ваша конвенция; дублирование board/workspace (проводка и дерево) не исчезает — его убирает модуль селекторов, а не стор.
Что Z упрощает против A: ~28 строк примитива и ручные адаптеры → библиотечный `useStore`/`useShallow`, селекторы, vanilla-подписка на срез, devtools-middleware, знакомый API. Цена: зависимость, дисциплина «селектор не строит новый объект», разница merge/replace.

**B. Keeper + `queryFn` (без экспериментальных хелперов).** В `packages/client` (не в React) создаётся `QueryObserver` на ключ домена, `subscribe(() => {})` держит его живым на всё время работы клиента; `queryFn` — обычная async-функция, которая в цикле читает watch и пишет `setQueryData`. Что реально даёт Query: ретраи с экспоненциальным backoff, наблюдаемый `status/fetchFailureReason`, `select` + tracked props, структурный шаринг (`replaceData`→`replaceEqualDeep`), батчинг уведомлений (`notifyManager.batchCalls`) [S: query-core 5.105.0, src/query.ts:473-477, src/queryObserver.ts:127, src/query.ts:103-112; react-query/src/useBaseQuery.ts:108-112].
Что остаётся вашим: политика на **чистое** завершение потока (Query ретраит только rejections; нормальный конец стрима = success с последними данными — переподключение писать самому), запрет на `cancelQueries`/`clear`/gc-удаление (иначе abort → cancel-сообщение на сокет, тот самый сценарий из `watch-store.ts:17-21`), чтения с `enabled: false`/`skipToken` (иначе чтение без данных попытается фетчить), `gcTime: Infinity`, `staleTime: 'static'`, `retryOnMount`/`refetchOnWindowFocus`/`refetchOnReconnect` выключить (дефолты: gc 5 мин, stale 0, retry 3, refetch на фокус [S: guides/important-defaults]). `fetchStatus` у keeper-запроса навсегда `'fetching'` [S: guides/reference/functions/experimental_streamedQuery про стрим-семантику] — индикатор соединения берётся из `connection.state`, не из Query.
Цена: keeper-реестр, обработка конца стрима, запрет отмен, статус-модель; выигрыш — селекторы/шаринг/ключи/батчинг и жизненный цикл из библиотеки.

**C. Ingest без `queryFn`.** Заменяет только кэш: ключи, `select`, шаринг, батчинг. Retry/error/cancel/dispose остаются в вашем `follow()` — т.е. вы удаляете `Store`, но **не** удаляете то, ради чего обычно берут Query. Query здесь не «чинит» падающий watch: ошибка ingest'а видна только если вы сами её запишете в кэш. Этот вариант оправдан, только если нужны именно форма кэша и селекторы, а не жизненный цикл.

Общее для B и C: `useQuery({queryKey, select})` в компонентах, деривация дерева/board — один модуль селекторов вместо двух; `packages/client` остаётся без React (query-core не имеет зависимостей, `@orpc/tanstack-query` объявляет peer `@tanstack/query-core` [S: package.json 1.16.1, registry]). `config` переезжает туда же как обычный домен, если выбран B/C; `KeymapProvider`/`config-context` остаются потребителями снапшота.

Ошибки/устаревание/гонки (B): `failed` копит `fetchFailureReason`, `status:'error'` — только после исчерпания ретраев [S: src/query.ts:458-477], поэтому при долгом обрыве это «данные + retry», без мигания ошибки; кросс-ключевой атомарности (`projects` и `tasks`) нет ни в A, ни в B. Отмена при уходе последнего наблюдателя откатывает состояние к состоянию **до fetch** [S: src/query.ts:630-650] — ранее закэшированные данные при этом остаются (устаревшие), теряются только если до fetch данных не было. В варианте B наблюдателей у keeper'а не ноль, поэтому это не срабатывает.

Рендеры: `select` + tracked props + шаринг уменьшают число перерисовок по построению [S: guides/render-optimizations]; ограничения — `select` стабильный, шаринг только для JSON-совместимых значений, rest-деструктуризация отключает tracked props. В A этого нет (`store.ts:23-27`, `use-workspace.ts:96-103`), но «нет» ≠ «измерено медленно».

Тестируемость: в B/C `packages/client` тестируется headless (`QueryClient.getQueryData`, `queryCache.subscribe`), web-тесты — свой клиент на тест (`retry:false`). В A это уже так и работает.

Мобильный/фреймворк-барьер: `query-core` без зависимостей, React Native берёт `@tanstack/react-query` поверх того же ядра [S: registry]. Это свойство B/C, но само по себе не причина переезда: мобильный — roadmap, а не текущая потребность.

---

## 4. Зрелость и издержки

- **oRPC-интеграция не «смотрит» сама.** `.queryOptions` — только `queryFn: client(input, {signal})`; подписка появляется в `.liveOptions`/`.streamedOptions`, которые в стабильном 1.16.1 называются `experimental_liveOptions`/`experimental_streamedOptions` [S: dist/index.mjs:21-90, 172-195 тарболла 1.16.1]. Неэкспериментальные имена — только в `2.0.0-beta.47`, на который и указывает orpc.dev [S: orpc.dev/docs/integrations/tanstack-query; тарболл beta]. `liveQuery` пишет каждый чанк через `setQueryData` и бросает, если поток не дал ни одного чанка; по завершении возвращает последний чанк — переподключения нет [S: packages/tanstack-query/src/live-query.ts:17-26]. Для B/C он не нужен: 15-20 строк своего `queryFn`/ingest на публичном `setQueryData`.
- **Отмена на WS.** Линк игнорирует `signal`; остановка — через `iterator.return()`, а в текущем коде отмена осознанно не делается из-за cancel-сообщения на закрытом сокете [S: watch-store.ts:17-21]. Значит главный «плюс» Query — безопасная отмена — здесь почти не применим: keeper живёт до закрытия клиента. Это ослабляет B, но не ломает.
- **TanStack DB** — `1.0.0-rc.1.1` (2026-10-31), тянет `@tanstack/db-ivm`, строковая модель с `getKey`, ломающие изменения API в этом же релизе [S: npm; tanstack.com/db/latest/docs/guides/migrate-to-1-0-rc]. Полный снапшот пришлось бы диффить в строки. Не сейчас.
- **Zustand 5.0.16 / Jotai 3.0.1 / `@tanstack/store` 0.11.2.** Ярлык «client-state» — не аргумент: стор есть стор, и Zustand vanilla может **владеть** push-снапшотом вместо самописного `Store`, без второго кэша (§3.Z). Возражения только по фичам и зрелости: нет структурного шаринга и retry watch; TanStack Store (`useSelector(store, selector, {compare})`, `batch`) ближе по форме, но 0.11.2 — pre-1.0; Jotai 3.0.1 — гранулярность на атом, для цельных снапшотов лишняя косвенность.
- **Версии:** React 19.3.1 (2026-10-14); query-core/react-query 5.105.0 (v5 с 2023-10-17, 0 зависимостей); orpc 1.16.1; db RC; zustand 5.0.16; jotai 3.0.1; `@tanstack/store` 0.11.2. v6 react-query в npm нет (dist-tags только 5.x) [S: registry, 2026-10-31].

---

## 5. Рекомендация

1. **Сейчас не мигрировать.** Ни один вариант не решает текущую задачу (интеграция фич), а измеренной проблемы рендеров нет.
2. **Отдельно, как баг, а не как архитектуру:** сброс `watching` при ошибке watch (`packages/client/src/watch-store.ts:29-49`) — единственный найденный корректностный риск (тихая устарелость при живом сокете).
3. **Выбор зависит от боли, а не от ярлыка библиотеки.** Болит ручная обвязка сторов/селекторов — **Z** (Zustand vanilla как единственный стор): дешевле B, без второго кэша, WS-владение не меняется, цена — зависимость и дисциплина `useShallow`. Болит жизненный цикл (retry/статус/шаринг на много доменов) — **B**, с оговорками §3: отмена здесь запрещена, конец стрима и keeper-реестр ваши, поэтому значимая часть цикла Query всё равно выключена. **C** — нет: оставляет вам ровно ту логику, ради замены которой затевается переезд, и покупает только форму кэша. **A** остаётся нормой, пока боли нет; дублирование board/workspace лечится одним модулем селекторов/деривации, а не выбором библиотеки.
4. **Не менять:** терминальный бинарь-WS и императивную запись в xterm, контракт/транспорт oRPC, reconnect/auth/capabilities, серверный авторитет и полные снапшоты, отсутствие polling. `config` при переезде — обычный домен кэша; `KeymapProvider`/`config-context` остаются, но как потребители, а не владельцы.
5. **Триггеры пересмотра** (любой один): болит ручная обвязка/селекторы (тогда Z), либо понадобился жизненный цикл (retry/статус/шаринг) на много доменов (тогда B); стартовал мобильный клиент; понадобилась инспекция кэша.

**Что требует решения пользователя:** (а) считать ли пункт 2 багом к починке в текущем слое; (б) какая боль реальна — обвязка/селекторы (тогда Z) или жизненный цикл (тогда B), либо ни то ни другое (A); (в) если B — согласны ли на keeper-реестр вне React и запрет `cancelQueries` как постоянное правило.

**Границы Z, если решат:** этап 1 — `createStore` на домен вместо `Store`, `follow()` без изменений, `setState(snapshot, true)`; этап 2 — 10 точек чтения на `useStore(api, selector)` (для объектов/массивов — `useShallow`), одна деривация дерева вместо двух, `config` как такой же стор; этап 3 — тесты на `getState`/`subscribe`, web-тесты без изменений. `Store`, `TerminalStream` и `connection.state` остаются.

**Границы B, если решат:** этап 1 — keeper-реестр + `queryFn`-стрим + конфиг дефолтов, удаление доменных watch-store; этап 2 — 10 точек чтения на `useQuery({queryKey, select})`, одна деривация дерева (board), `config` как домен; этап 3 — headless-тесты клиента, web-тесты на своём клиенте. Обратный путь — revert ветки. Риск B — семантика жизненного цикла (конец стрима, отмена, `fetchStatus`), риск Z — дисциплина селекторов и зависимость.
