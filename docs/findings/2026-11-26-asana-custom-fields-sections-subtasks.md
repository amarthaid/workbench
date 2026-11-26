# Asana custom fields, sections, start dates and subtasks

An agent reporting on a product roadmap said the Asana tools did not return
custom fields, sections or start dates, so it had to fall back to a hand-made
export, and could not see the dated phase subtasks at all. It was right: the
plugin asked Asana only for name, notes, completed, assignee, due date, project
names and permalink, and had no subtask or section tool.

Nothing was missing on Asana's side. Everything comes back through `opt_fields`
on the endpoints already in use, plus `/tasks/{gid}/subtasks` and
`/projects/{gid}/sections`. Checked against a live workspace through a
`curl_session`, read-only, before any code was written.

## What the API does

- **Custom fields** come back as a list. Which key carries the value depends on
  the field's type: `enum_value.name`, `multi_enum_values.name`, `number_value`,
  `text_value`, `date_value` (`{ date, date_time }`), `people_value.name`.
  `display_value` is a string form for every type, but it is only used as a
  fallback for unknown types, because the typed keys keep numbers as numbers and
  dates as ISO dates.
- **Empty fields are still listed**, with null values. On a project with many
  unused fields that is most of the payload, so reads drop them.
- **Two fields can share a name.** Some projects carry two custom fields both
  called "Status", and some names end in a space. A `{ name: value }` map needs a
  rule for the collision (the later one becomes `Status (2)`), and a write by
  name needs one too: match case-insensitively and trimmed, accept a field gid as
  the key, and refuse an ambiguous name with the gids in the message rather than
  guess.
- **Sections** are `memberships.section.name`, one entry per project the task is
  in. In a project listing, the right entry is the one whose project matches the
  project that was asked for.
- **`start_on`** is a plain task field.
- **Subtasks** carry their own `start_on` and `due_on`, which is where teams that
  model delivery phases as subtasks keep their schedule. They page with
  `next_page.offset`. Their custom fields are the parent project's, mostly empty.

## What writes need

Asana writes custom fields as `custom_fields: { <field gid>: <value> }`, and an
enum value is an option gid, a multi-enum value a list of option gids, a date
`{ date }`, `null` clears. Writing a name an agent can say instead of a gid means
fetching the field definitions first (`custom_fields.enum_options` on the task for
an update, `custom_field_settings` on the project for a create). A section move is
a separate call, `POST /sections/{gid}/addTask`.

So the tools resolve and validate everything before the first write. An unknown
field, option or section throws with the valid names, and nothing has changed. A
typo that left a task with its name updated but its status not would be worse than
a refusal.

Asana returns `{ errors: [...] }` with a non-2xx status, and the old handlers
read `body.data ?? {}`, so a rejected write came back as an empty task that
looked like success. Writes and `asana_get_task` now throw the first error
message.

## Not verified live

Reads were checked against a real workspace. Writes were not: Asana has no dry
run, and the encodings above come from its documentation and are covered by unit
tests with mocked replies. A populated date custom field was not found to
inspect, so the `date_value` shape is the documented one.
