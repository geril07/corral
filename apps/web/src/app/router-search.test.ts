import { expect, test } from "vite-plus/test";
import { parseRouteSearch } from "./router-search.ts";

test("the desktop server query is removed from the hash route search", () => {
  const documentSearch = "?server=ws%3A%2F%2F127.0.0.1%3A4317";
  const search = "?project=p1&task=t1&entry=e1?server=ws%3A%2F%2F127.0.0.1%3A4317";

  expect(parseRouteSearch(search, documentSearch)).toEqual({
    project: "p1",
    task: "t1",
    entry: "e1",
  });
});

test("a hash without its own search keeps the desktop query out of the route", () => {
  const documentSearch = "?server=ws%3A%2F%2F127.0.0.1%3A4317";

  expect(parseRouteSearch(documentSearch, documentSearch)).toEqual({});
});

test("a search that does not end with the document query is parsed as it is", () => {
  expect(parseRouteSearch("?project=p1&entry=e1", "")).toEqual({
    project: "p1",
    entry: "e1",
  });
});

test("ids that look like JSON numbers stay strings", () => {
  expect(parseRouteSearch("?project=123456789012&task=123e4567&entry=123456789012", "")).toEqual({
    project: "123456789012",
    task: "123e4567",
    entry: "123456789012",
  });
});
