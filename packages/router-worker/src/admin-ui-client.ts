/**
 * The admin console behavior script, served verbatim inside a <script> tag.
 *
 * Every fragment MUST stay a template literal with zero interpolation: the
 * previous implementation serialized a bundled function via .toString(),
 * which let esbuild's keepNames helper calls (__name) leak into the page
 * and crash the whole script in production. Nothing here is derived from
 * bundled code; configuration crosses via the #admin-ui-config JSON blob.
 *
 * The fragments live in ./client and are concatenated verbatim below, so the
 * served bytes are identical to the single literal this replaced. They are not
 * independently valid scripts: the IIFE opens in the prelude and closes in the
 * boot fragment, and each one begins exactly where the previous one ended, so
 * their order here is load-bearing.
 */
import { CLIENT_ACTIONS } from './client/actions'
import { CLIENT_BOOT } from './client/boot'
import { CLIENT_DRAWERS } from './client/drawers'
import { CLIENT_EVENTS } from './client/events'
import { CLIENT_FORMAT } from './client/format'
import { CLIENT_LOADERS } from './client/loaders'
import { CLIENT_MESH_CARD } from './client/mesh-card'
import { CLIENT_NODES_TABLE } from './client/nodes-table'
import { CLIENT_NODE_STATE } from './client/node-state'
import { CLIENT_PLAYGROUND } from './client/playground'
import { CLIENT_PRELUDE } from './client/prelude'
import { CLIENT_SESSION } from './client/session'
import { CLIENT_SPLIT_READINESS } from './client/split-readiness'
import { CLIENT_STATUS_PANELS } from './client/status-panels'
import { CLIENT_VIEW } from './client/view'

/**
 * The fragments in the one order that produces a valid script. Exported so a test can
 * assert each one reaches the page exactly once and in this order: a dropped, duplicated
 * or reordered fragment still concatenates into a string, and the browser would be the
 * first thing to notice.
 */
export const ADMIN_UI_CLIENT_FRAGMENTS: readonly string[] = [
  CLIENT_PRELUDE,
  CLIENT_VIEW,
  CLIENT_FORMAT,
  CLIENT_SPLIT_READINESS,
  CLIENT_NODE_STATE,
  CLIENT_NODES_TABLE,
  CLIENT_DRAWERS,
  CLIENT_PLAYGROUND,
  CLIENT_MESH_CARD,
  CLIENT_STATUS_PANELS,
  CLIENT_LOADERS,
  CLIENT_SESSION,
  CLIENT_ACTIONS,
  CLIENT_EVENTS,
  CLIENT_BOOT
]

export const ADMIN_UI_CLIENT_SCRIPT: string = ADMIN_UI_CLIENT_FRAGMENTS.join('')
