# Scratch workspaces

A task created without a project gets its own server-created directory under `<data dir>/scratch`.
The directory name combines the creation date, a prompt/title slug and a short unique id. Creating
the task, not opening a draft or browsing metadata, creates the directory. Reopening a task uses the
recorded path. A scratch task has no project or Git branch; Corral does not initialize a repository.

Changes and other Git operations are unavailable for scratch tasks, even when the data directory
is inside an existing repository. The Changes watch and file summary report that Git is unavailable
instead of inspecting an ancestor repository.

Removing a scratch task stops its sessions and closes loose terminals in its directory, but keeps
the directory and all its files, including ignored files. Another task's directory is untouched.
If creation fails after the directory is made, Corral also leaves that directory in place, whether
or not the task row was recorded: files may already have appeared there and are not safe to delete.
The task's default agent view uses global task settings, not a project's overrides.
