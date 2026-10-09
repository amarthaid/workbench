---
title: Storybooks
description: Connect a deployed Storybook 8 so an agent can list stories, read component props, pull design tokens, and map Figma components.
---

Storybooks reads a deployed Storybook 8 static build. The agent can list and search stories, open one story's docs text, group components, read argTypes from the compiled story chunk, build a JSX example from story presets, collect CSS custom properties from the iframe stylesheets, and map a Figma component onto the matching Storybook component. The deployment is never written to. Figma itself is not called.

## At a glance

| | |
|---|---|
| Plugin id | `storybooks` |
| Auth | API key (URL plus an optional credential) |
| Tools | 17 |
| Data | `index.json`, `iframe.html`, and `/assets/*` under the connected URL |
| Curl proxy | No |

There is no OAuth app and no callback URL. Each user pastes the Storybook URL in the portal. A public deployment uses auth type `none`.

## Connection fields

| Field | Required | Notes |
|---|---|---|
| `baseUrl` | Yes | Storybook origin, for example `https://storybook.example.com`. A subpath is kept. `http` and `https` only. Credentials in the URL are rejected. |
| `authType` | Yes | `none`, `bearer`, `basic`, or `cookie`. |
| `username` | For basic | Basic-auth username. Ignored for the other types. |
| `credential` | Yes | For `none`, type `none`. For `bearer`, the token. For `basic`, the password. For `cookie`, the `Cookie` header value. Stored encrypted. |
| `figmaMappings` | No | JSON array that pins a Figma component to a Storybook component. Each row needs `storybookComponent` and one of `figmaName`, `figmaNodeId`, `figmaUrl`. |

The credential is attached only to requests whose host is the connected origin. `storybooks_compare_versions` fetches the other deployment with no credential, so that URL has to be public. Hosts that are private addresses, or that resolve to one, are refused.

## Figma mapping

`storybooks_map_figma_component` does not call the Figma API. It matches a Figma component name, node id, or URL onto a story in the connected index.

A row in `figmaMappings` wins. `figmaNodeId` `12:34` and a URL `node-id=12-34` are the same node. `props` and `storyId` on that row are returned as-is.

Without a row, the tool splits the Figma name on `/`. The first segment must match a story title (`Button` matches `Components/Button`). Later segments become suggested props (`Button / Primary` suggests `variant: primary`) and pick the closest story. A node id with no mapping row returns no match.

## Server configuration

None. API-key integrations have no client id or secret.

## Connect

Portal: Connections → **Connect** on the Storybooks card → fill the fields → submit. The connection is live immediately.

`connect({ integration: "storybooks" })` does not open this form. That meta-tool builds an OAuth URL, and this integration is not OAuth. Point the user at the portal, then check `list_integrations`.

## Tools

| Tool | Purpose |
|---|---|
| `storybooks_list_stories` | Index rows, filterable by query, category, and tags |
| `storybooks_search_stories` | Ranked search over title, name, id, tags, and import path |
| `storybooks_get_story` | One story, plus docs text when the chunk can be read |
| `storybooks_get_story_section` | One section from that text |
| `storybooks_get_story_metadata` | Index row only |
| `storybooks_get_story_context` | Short context for a question |
| `storybooks_list_components` | Components grouped by story title |
| `storybooks_get_component` | Variants for one component |
| `storybooks_get_component_config` | argTypes and story presets from the compiled chunk |
| `storybooks_get_component_usage` | A JSX example built from those presets |
| `storybooks_find_stories_by_source` | Stories whose import or component path contains a file |
| `storybooks_preview_story` | Iframe URL on the connected origin, with encoded args |
| `storybooks_get_catalog_summary` | Compact catalog to check before adding a component |
| `storybooks_get_design_tokens` | CSS custom properties from iframe stylesheets |
| `storybooks_map_figma_component` | Match a Figma component name or node id to a Storybook component |
| `storybooks_compare_versions` | Index diff against another public Storybook URL |
| `storybooks_get_story_instructions` | CSF3 notes using the common title prefix in this index |

Storybook 7 `stories.json` is not read. Docs text and argTypes depend on the static build publishing an iframe bundle that maps story files to chunks. When that map is missing, metadata tools still work and the config tool says so.
