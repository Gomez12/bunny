# Version history

Every editable item in Bunny tracks its own version history. Open the history from the small **clock icon** next to the item; pick any prior version and restore it in one click.

## Where to find it

Look for a small **clock icon** (lucide `History`) near the item's other action icons:

- In list rows (documents, contacts, scripts, planning items, …).
- In card headers (board cards, agents, skills, businesses).
- In detail-view toolbars (whiteboards, diagrams, code projects, diary entries).

A subtle dot next to the icon means at least one prior version exists. No dot means the item has never been edited since it was created.

## What's tracked

| Marker | When it's recorded |
| --- | --- |
| **Saved** | Every time you save an edit. Multiple saves within five minutes by the same user collapse into one entry to keep the timeline readable. |
| **Before delete** | When you move the item to the trash. The snapshot is the exact state you threw away. |
| **Before restore** | When you restore the item to a prior version. Lets you undo the restore. |
| **Restored** | The actual restore action. |
| **Imported** | Backfilled from the previous script-versions table the first time you opened a database that already had script history. |

Background work (translations, auto-builds, web-news fetches) is intentionally *not* recorded — only the changes you make yourself.

## Restoring a version

1. Click the clock icon next to the item.
2. Pick a version on the left. The right pane shows the snapshot.
3. Click **Restore this version**.
4. Confirm in the dialog. Bunny captures a *Before restore* snapshot of the current state first, so you can roll back if needed.

The current row is updated in place — the page reloads to reflect the restored content.

## Limits

- Each item keeps the most recent 200 *Saved* versions; *Before delete*, *Before restore*, *Restored*, and the original *v1* are always kept. Pruning runs daily.
- Very large snapshots (over 1 MB) are recorded as a marker without the payload. The timeline still shows when the change happened, but the restore button is greyed out for that row.
- Trashed items have to be restored from the **Trash bin** (Settings → Trash) first before you can browse or restore their version history.

## What you'll see in the snapshot

The detail pane shows the full row as JSON. Per-item rendering (rich-text preview for documents, image preview for whiteboards, etc.) is a planned follow-up — the JSON view works for every item type today.

## Permissions

- **Admins** can see and restore every item's history.
- **Project members** can see and restore history for any item inside a project they can edit (public projects, or projects they created).
- **Personal items** (your own agents, skills, scheduled tasks) are visible only to you.

## Related

- Trash bin (Settings → Trash) — recover deleted items before browsing their history.
- Developer reference: [`docs/dev/architecture/entities/entity-versioning.md`](../../dev/architecture/entities/entity-versioning.md).
