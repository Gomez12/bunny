/**
 * Register all built-in tools onto the shared registry.
 * Import this module once at startup (e.g. from src/index.ts).
 */

import { registry } from "./registry.ts";
import { readFileHandler, READ_FILE_SCHEMA } from "./fs_read.ts";
import { listDirHandler, LIST_DIR_SCHEMA } from "./fs_list.ts";
import { editFileHandler, EDIT_FILE_SCHEMA } from "./fs_edit.ts";

registry.register(
  "read_file",
  "Read the contents of a file at a given path.",
  READ_FILE_SCHEMA,
  readFileHandler,
);
registry.register(
  "list_dir",
  "List directory entries at a given path.",
  LIST_DIR_SCHEMA,
  listDirHandler,
);
registry.register(
  "edit_file",
  "Replace an exact string in a file. The old_string must appear exactly once.",
  EDIT_FILE_SCHEMA,
  editFileHandler,
);

export { registry };
