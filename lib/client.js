/**
 * Session Manager — the browser half.
 *
 * Two entry points share one Host route:
 *
 *   1. one row in a Session row's "…" menu. The row opens a confirmation dialog
 *      (rendered in `shell.overlay`, styled from the Host's own tokens) that
 *      deletes exactly that Session,
 *   2. a "Sessions" panel in the sidebar's icon column. Selecting it opens a
 *      console in `shell.overlay` that lists every Session in the workspace
 *      list, filters by tab and search, sorts, and deletes rows one at a time
 *      or in a guarded batch.
 *
 * Both paths run the same deletion: archive through `uiWorkspace` (which stops
 * running work and clears the main view when this Session is on screen), POST
 * the id to this package's Host route (which drops the membership, archive and
 * pin ids, the log directories and the projection cache), then drop the row
 * locally so the sidebar agrees with the Host even when the Session never had a
 * live in-memory entry to release.
 *
 * There is no toast slot to borrow and no primitive package to import (plugin
 * code must bring its own controls), so the menu row, the dialogs and the
 * console are plain markup with `sp-`/`spc-` prefixed classes.
 */

window.__ModuleLoader__.load({
	id: '@kissblank/dsh-session-manager',
	factory(require) {
		const React = require('react')
		const h = React.createElement

		const NS = 'session-manager'
		const SESSION_MENU = 'sidebar.workspaces.session.menu.item'
		const OVERLAY = 'shell.overlay'
		const MAIN = 'main'
		const PANELLIST = 'sidebar.panellist'
		/** The sidebar id and the `main` key are the same value, by contract. */
		const PANEL_ID = 'session-console'
		const PURGE_PATH = 'session-manager/api/purge'
		const INVENTORY_PATH = 'session-manager/api/inventory'
		const CACHE_UPKEEP_PATH = 'session-manager/api/maintenance/cache'
		const DIRECTORY_UPKEEP_PATH = 'session-manager/api/maintenance/directories'
		const TOAST_MS = 4000
		const SEARCH_DELAY_MS = 220
		const NOTICE_MS = 6000
		const ROW_HEIGHT = 44
		const OVERSCAN = 6
		/** How often a visible "3 minutes ago" is recomputed. */
		const CLOCK_MS = 30000
		const STORAGE_KEY = 'session-manager.console.v1'

		const EN = {
			'menu.purgeSession': 'Delete permanently…',
			'dialog.title': 'Delete this session permanently?',
			'dialog.description': 'Its log, archive and pin records, projection cache and sidebar entry are removed from this machine. This cannot be undone.',
			'dialog.cancel': 'Cancel',
			'dialog.close': 'Close',
			'dialog.confirm': 'Delete permanently',
			'dialog.running': 'Deleting…',
			'dialog.failed': 'Deletion failed. {message}',
			'dialog.failedArchived': 'Deletion failed, and the session is now only archived. {message}',
			'toast.done': '“{title}” was deleted permanently',
			'error.network': 'The host could not be reached.',
			'error.unknown': 'The host did not answer.',
			'panel.title': 'Sessions',
			'console.title': 'Sessions',
			'console.close': 'Close',
			'console.tab.all': 'All',
			'console.tab.active': 'Active',
			'console.tab.archived': 'Archived',
			'console.search': 'Search by title, id, or workspace',
			'console.sort.label': 'Sort',
			'console.sort.activity': 'Last active',
			'console.sort.created': 'Created',
			'console.col.title': 'Session',
			'console.col.status': 'Status',
			'console.col.updated': 'Last active',
			'console.col.workspace': 'Workspace',
			'console.col.actions': 'Actions',
			'console.status.running': 'Running',
			'console.status.pending': 'Waiting',
			'console.status.idle': 'Idle',
			'console.archivedBadge': 'Archived',
			'console.noWorkspace': 'Ungrouped',
			'console.action.unarchive': 'Unarchive',
			'console.action.purge': 'Delete permanently',
			'console.selectAll': 'Select all results',
			'console.clearSelection': 'Clear selection',
			'console.selectedCount': '{count} selected',
			'console.bulkPurge': 'Delete selected',
			'console.empty.all': 'No sessions yet',
			'console.empty.active': 'No active sessions',
			'console.empty.archived': 'No archived sessions',
			'console.empty.search': 'No matching sessions',
			'console.confirm.title.one': 'Delete “{title}” permanently?',
			'console.confirm.title.many': 'Delete {count} sessions permanently?',
			'console.confirm.desc': 'Each session’s log, archive and pin records, projection cache and sidebar entry are removed from this machine. This cannot be undone.',
			'console.confirm.running': 'Warning: {running} of the {count} selected sessions are still working. Deleting them forces their tasks to stop and destroys them permanently.',
			'console.confirm.force': 'I confirm force-stopping those running tasks',
			'console.confirm.irreversible': 'I understand this cannot be undone',
			'console.confirm.cancel': 'Cancel',
			'console.confirm.action': 'Delete permanently',
			'console.progress.title': 'Deleting {count} sessions',
			'console.progress.stopping': 'Stopping tasks ({done}/{total})…',
			'console.progress.done': '{count} sessions deleted',
			'console.progress.partial': '{done} deleted, {failed} failed',
			'console.failedRow': 'Delete failed: {message}',
			'console.failedRowArchived': 'Delete failed, left archived: {message}',
			'console.error.unarchive': 'Unarchive failed: {message}',
			'console.more': 'Cleanup',
			'console.more.cache': 'Clear orphaned cache',
			'console.more.cacheHint': 'Projection-cache records whose session no longer exists.',
			'console.more.directories': 'Remove empty workspace folders',
			'console.more.directoriesHint': 'Session folders that hold no session at all.',
			'console.upkeep.none': 'Nothing to clean up.',
			'console.upkeep.cacheDone': 'Cleared {count} orphaned cache record(s), {size} freed.',
			'console.upkeep.directoriesDone': 'Removed {count} empty folder(s).',
			'console.upkeep.skipped': 'Not available on this host ({reason}).',
			'console.error.upkeep': 'Cleanup failed: {message}',
			'time.justNow': 'just now',
			'time.minutes': '{count} min ago',
			'time.hours': '{count} h ago',
			'time.days': '{count} d ago',
		}

		const ZH = {
			'menu.purgeSession': '彻底删除…',
			'dialog.title': '彻底删除这个会话？',
			'dialog.description': '该会话的日志、归档与置顶记录、投影缓存以及侧栏中的条目都会从本机移除，且无法撤销。',
			'dialog.cancel': '取消',
			'dialog.close': '关闭',
			'dialog.confirm': '彻底删除',
			'dialog.running': '正在删除…',
			'dialog.failed': '删除失败：{message}',
			'dialog.failedArchived': '删除失败，会话目前仅处于归档状态：{message}',
			'toast.done': '已彻底删除“{title}”',
			'error.network': '无法连接宿主。',
			'error.unknown': '宿主没有返回结果。',
			'panel.title': '会话管理',
			'console.title': '会话管理',
			'console.close': '关闭',
			'console.tab.all': '全部会话',
			'console.tab.active': '未归档',
			'console.tab.archived': '已归档',
			'console.search': '搜索标题、ID 或工作区',
			'console.sort.label': '排序',
			'console.sort.activity': '最后活跃',
			'console.sort.created': '创建时间',
			'console.col.title': '会话',
			'console.col.status': '状态',
			'console.col.updated': '最后活跃',
			'console.col.workspace': '工作区',
			'console.col.actions': '操作',
			'console.status.running': '运行中',
			'console.status.pending': '等待确认',
			'console.status.idle': '空闲',
			'console.archivedBadge': '已归档',
			'console.noWorkspace': '未分组',
			'console.action.unarchive': '取消归档',
			'console.action.purge': '彻底删除',
			'console.selectAll': '全选当前结果',
			'console.clearSelection': '取消选择',
			'console.selectedCount': '已选 {count} 个',
			'console.bulkPurge': '批量彻底删除',
			'console.empty.all': '还没有任何会话',
			'console.empty.active': '没有未归档的会话',
			'console.empty.archived': '没有已归档的会话',
			'console.empty.search': '没有匹配的会话',
			'console.confirm.title.one': '彻底删除“{title}”？',
			'console.confirm.title.many': '彻底删除 {count} 个会话？',
			'console.confirm.desc': '这些会话的日志、归档与置顶记录、投影缓存以及侧栏条目都会从本机移除，且无法撤销。',
			'console.confirm.running': '注意：你选中的 {count} 个会话中，有 {running} 个正在运行。点击删除将强制中断它们的任务并彻底销毁。',
			'console.confirm.force': '我确认强制中断这些运行中的任务',
			'console.confirm.irreversible': '我已知晓无法恢复',
			'console.confirm.cancel': '取消',
			'console.confirm.action': '彻底删除',
			'console.progress.title': '正在删除 {count} 个会话',
			'console.progress.stopping': '正在停止任务 ({done}/{total})…',
			'console.progress.done': '已删除 {count} 个会话',
			'console.progress.partial': '已删除 {done} 个，{failed} 个失败',
			'console.failedRow': '删除失败：{message}',
			'console.failedRowArchived': '删除失败，会话目前仅处于归档状态：{message}',
			'console.error.unarchive': '取消归档失败：{message}',
			'console.more': '清理',
			'console.more.cache': '清理无主缓存',
			'console.more.cacheHint': '会话已不存在的投影缓存记录。',
			'console.more.directories': '清理空工作区目录',
			'console.more.directoriesHint': 'sessions 下不含任何会话的目录。',
			'console.upkeep.none': '没有需要清理的内容。',
			'console.upkeep.cacheDone': '清理了 {count} 条无主缓存，释放 {size}。',
			'console.upkeep.directoriesDone': '删除了 {count} 个空目录。',
			'console.upkeep.skipped': '当前宿主不支持该操作（{reason}）。',
			'console.error.upkeep': '清理失败：{message}',
			'time.justNow': '刚刚',
			'time.minutes': '{count} 分钟前',
			'time.hours': '{count} 小时前',
			'time.days': '{count} 天前',
		}

		const CSS = `
.sp-menuRow {
	position: relative;
}
.sp-menuSeparator {
	height: .5px;
	margin: 3px 2px;
	background: var(--dsw-alias-border-l2, rgba(127, 127, 127, .24));
}
.sp-menuItem {
	display: flex;
	align-items: center;
	gap: 6px;
	width: 100%;
	min-height: 30px;
	padding: 4px 8px;
	border: none;
	border-radius: var(--dsw-radius-md, 6px);
	background: transparent;
	color: var(--dsw-alias-state-error-primary, #e5484d);
	font-family: inherit;
	font-size: 13px;
	line-height: 20px;
	text-align: left;
	cursor: pointer;
}
.sp-menuItem:hover:not(:disabled),
.sp-menuItem:focus-visible:not(:disabled) {
	background: var(--dsw-alias-interactive-bg-hover-danger, rgba(229, 72, 77, .12));
	outline: none;
}
.sp-menuItem:disabled {
	cursor: not-allowed;
	opacity: .4;
}
.sp-menuIcon {
	display: inline-flex;
	flex: none;
	align-items: center;
	justify-content: center;
	width: 14px;
	height: 14px;
	color: var(--dsw-alias-state-error-primary, #e5484d);
}
.sp-menuIcon svg {
	width: 14px;
	height: 14px;
}
.sp-menuLabel {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.sp-layer {
	position: fixed;
	inset: 0;
	z-index: 1000;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: max(24px, var(--dsh-frame-overlay-top, 24px)) 24px;
	pointer-events: none;
}
.sp-mask {
	position: absolute;
	inset: var(--dsh-frame-chrome-top, 0px) 0 0;
	background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, .32));
	backdrop-filter: var(--dsw-mask-blur, blur(2px));
	pointer-events: auto;
}
.sp-dialog {
	position: relative;
	display: flex;
	flex-direction: column;
	gap: 20px;
	width: min(420px, 100%);
	padding: 0 0 24px;
	border-radius: var(--dsw-radius-panel, 14px);
	background: var(--dsw-alias-bg-layer-2, #1f2023);
	color: var(--dsw-alias-label-primary, #f5f5f7);
	box-shadow: var(--dsw-elevation-prominent, 0 18px 48px rgba(0, 0, 0, .45));
	pointer-events: auto;
}
.sp-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	padding: 22px 14px 0 24px;
}
.sp-title {
	margin: 0;
	font-size: 16px;
	line-height: 24px;
	font-weight: 500;
}
.sp-close {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 28px;
	height: 28px;
	padding: 0;
	border: none;
	border-radius: var(--dsw-radius-sm, 6px);
	background: transparent;
	color: var(--dsw-alias-label-secondary, #a1a1a6);
	cursor: pointer;
}
.sp-close:hover:not(:disabled) {
	background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .14));
}
.sp-close:disabled {
	cursor: not-allowed;
	opacity: .4;
}
.sp-description {
	margin: 0;
	padding: 0 24px;
	color: var(--dsw-alias-label-secondary, #a1a1a6);
	font-size: 14px;
	line-height: 22px;
}
.sp-body {
	display: flex;
	flex-direction: column;
	gap: 10px;
	padding: 0 24px;
}
.sp-target {
	display: flex;
	flex-direction: column;
	gap: 2px;
	padding: 10px 12px;
	border: .5px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, .24));
	border-radius: var(--dsw-radius-md, 8px);
	background: var(--dsw-alias-bg-layer-1, transparent);
}
.sp-target-title {
	font-size: 14px;
	line-height: 20px;
	overflow-wrap: anywhere;
}
.sp-target-id {
	color: var(--dsw-alias-label-tertiary, #8e8e93);
	font-size: 12px;
	line-height: 18px;
	overflow-wrap: anywhere;
}
.sp-status {
	color: var(--dsw-alias-label-secondary, #a1a1a6);
	font-size: 12px;
	line-height: 18px;
}
.sp-error {
	color: var(--dsw-alias-state-error-primary, #e5484d);
	font-size: 12px;
	line-height: 18px;
	overflow-wrap: anywhere;
}
.sp-footer {
	display: flex;
	align-items: center;
	justify-content: flex-end;
	gap: 8px;
	padding: 0 24px;
}
.sp-button {
	box-sizing: border-box;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 4px;
	height: 36px;
	min-width: 72px;
	padding: 0 14px;
	border: none;
	border-radius: var(--dsw-radius-md, 8px);
	background: transparent;
	color: var(--dsw-alias-label-primary, #f5f5f7);
	font-family: inherit;
	font-size: 14px;
	line-height: 22px;
	cursor: pointer;
}
.sp-button:hover:not(:disabled) {
	background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .14));
}
.sp-button:disabled {
	cursor: not-allowed;
	opacity: .4;
}
.sp-button-sm {
	height: 28px;
	min-width: 0;
	padding: 0 10px;
	font-size: 12px;
	line-height: 18px;
}
.sp-danger {
	border: .5px solid var(--dsw-alias-border-l3, rgba(127, 127, 127, .4));
	color: var(--dsw-alias-state-error-primary, #e5484d);
}
/* The final confirmation of a destructive deletion: the one filled red action
   in this plugin, so the button that destroys data is unmistakable. */
.sp-danger-solid {
	border: none;
	background: var(--dsw-alias-state-error-primary, #e5484d);
	color: var(--dsw-alias-label-primary-foreground, #fff);
}
.sp-danger-solid:hover:not(:disabled) {
	background: var(--dsw-alias-label-error, #f2555a);
	color: var(--dsw-alias-label-primary-foreground, #fff);
}
.sp-toast {
	position: fixed;
	left: 50%;
	bottom: 28px;
	display: inline-flex;
	align-items: center;
	gap: 8px;
	max-width: min(520px, calc(100vw - 48px));
	padding: 10px 14px;
	border: .5px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, .24));
	border-radius: var(--dsw-radius-md, 10px);
	background: var(--dsw-alias-bg-layer-2, #1f2023);
	color: var(--dsw-alias-label-primary, #f5f5f7);
	font-size: 13px;
	line-height: 20px;
	box-shadow: var(--dsw-elevation-prominent, 0 12px 32px rgba(0, 0, 0, .35));
	transform: translateX(-50%);
	pointer-events: none;
}
.sp-toast-icon {
	display: inline-flex;
	color: var(--dsw-alias-state-success-primary, #30d158);
}
.sp-toast-text {
	overflow-wrap: anywhere;
}
.spc-layer {
	position: fixed;
	inset: 0;
	z-index: 1000;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 24px;
	pointer-events: none;
}
.spc-mask {
	position: absolute;
	inset: var(--dsh-frame-chrome-top, 0px) 0 0;
	background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, .32));
	backdrop-filter: var(--dsw-mask-blur, blur(2px));
	pointer-events: auto;
}
.spc-panel {
	position: relative;
	display: flex;
	flex-direction: column;
	width: min(1040px, 100%);
	height: min(660px, 100%);
	min-height: 0;
	border: .5px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, .24));
	border-radius: var(--dsw-radius-panel, 14px);
	background: var(--dsw-alias-bg-layer-2, #1f2023);
	color: var(--dsw-alias-label-primary, #f5f5f7);
	box-shadow: var(--dsw-elevation-prominent, 0 18px 48px rgba(0, 0, 0, .45));
	overflow: hidden;
	pointer-events: auto;
}
.spc-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	padding: 18px 16px 6px 20px;
}
.spc-title {
	margin: 0;
	font-size: 16px;
	line-height: 24px;
	font-weight: 500;
}
.spc-header-actions {
	display: inline-flex;
	align-items: center;
	gap: 4px;
}
.spc-more {
	position: relative;
	display: inline-flex;
}
.spc-more-button {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 28px;
	height: 28px;
	padding: 0;
	border: none;
	border-radius: var(--dsw-radius-sm, 4px);
	background: transparent;
	color: var(--dsw-alias-label-secondary, #9aa0a6);
	cursor: pointer;
}
.spc-more-button:hover:not(:disabled) {
	background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .12));
	color: var(--dsw-alias-label-primary, #e6e6e6);
}
.spc-more-button:disabled {
	opacity: .4;
	cursor: default;
}
.spc-more-menu {
	position: absolute;
	top: 32px;
	right: 0;
	z-index: 8;
	display: flex;
	flex-direction: column;
	min-width: 260px;
	padding: 4px;
	border: .5px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, .3));
	border-radius: var(--dsw-radius-md, 6px);
	background: var(--dsw-alias-bg-layer-2, #262626);
	box-shadow: var(--dsw-elevation-prominent, 0 18px 48px rgba(0, 0, 0, .45));
}
.spc-more-item {
	display: flex;
	flex-direction: column;
	gap: 2px;
	width: 100%;
	padding: 6px 8px;
	border: none;
	border-radius: var(--dsw-radius-md, 6px);
	background: transparent;
	color: var(--dsw-alias-label-primary, #e6e6e6);
	font: inherit;
	font-size: 13px;
	line-height: 20px;
	text-align: left;
	cursor: pointer;
}
.spc-more-item:hover:not(:disabled) {
	background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .12));
}
.spc-more-item:disabled {
	opacity: .5;
	cursor: default;
}
.spc-more-hint {
	font-size: 12px;
	line-height: 16px;
	color: var(--dsw-alias-label-secondary, #9aa0a6);
}
.spc-toolbar {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 8px 20px 12px;
	flex-wrap: wrap;
}
.spc-tabs {
	display: inline-flex;
	gap: 2px;
	padding: 2px;
	border-radius: 999px;
	background: var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, .08));
}
.spc-tab {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	height: 26px;
	padding: 0 10px;
	border: none;
	border-radius: 999px;
	background: transparent;
	color: var(--dsw-alias-label-secondary, #a1a1a6);
	font-family: inherit;
	font-size: 13px;
	line-height: 18px;
	cursor: pointer;
}
.spc-tab:hover {
	color: var(--dsw-alias-label-primary, #f5f5f7);
}
.spc-tab[aria-selected="true"] {
	background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .16));
	color: var(--dsw-alias-label-primary, #f5f5f7);
}
.spc-count {
	color: var(--dsw-alias-label-tertiary, #8e8e93);
	font-size: 12px;
}
.spc-tab[aria-selected="true"] .spc-count {
	color: inherit;
	opacity: .7;
}
.spc-search {
	flex: 1 1 180px;
	min-width: 140px;
	height: 30px;
	padding: 0 10px;
	border: .5px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, .24));
	border-radius: var(--dsw-radius-md, 8px);
	background: var(--dsw-alias-bg-layer-1, transparent);
	color: inherit;
	font-family: inherit;
	font-size: 13px;
}
.spc-search:focus-visible {
	outline: none;
	border-color: var(--dsw-alias-border-l3, rgba(127, 127, 127, .4));
}
.spc-sort {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	color: var(--dsw-alias-label-secondary, #a1a1a6);
	font-size: 12px;
}
.spc-select {
	height: 30px;
	padding: 0 6px;
	border: .5px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, .24));
	border-radius: var(--dsw-radius-md, 8px);
	background: var(--dsw-alias-bg-layer-1, transparent);
	color: inherit;
	font-family: inherit;
	font-size: 13px;
}
.spc-notice,
.spc-alert {
	margin: 0 20px 8px;
	padding: 8px 10px;
	border-radius: var(--dsw-radius-md, 8px);
	font-size: 12px;
	line-height: 18px;
}
.spc-notice {
	background: var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, .08));
	color: var(--dsw-alias-label-secondary, #a1a1a6);
}
.spc-alert {
	border: .5px solid var(--dsw-alias-state-error-primary, #e5484d);
	color: var(--dsw-alias-state-error-primary, #e5484d);
	overflow-wrap: anywhere;
}
/* The table wrapper only exists to carry the ARIA table role; it has to pass
   the panel's height through to the scrolling list unchanged. */
.spc-table {
	display: flex;
	flex-direction: column;
	flex: 1;
	min-height: 0;
}
.spc-head {
	display: grid;
	grid-template-columns: 28px minmax(0, 1fr) 96px 112px 132px 64px;
	align-items: center;
	gap: 8px;
	height: 30px;
	padding: 0 20px;
	color: var(--dsw-alias-label-tertiary, #8e8e93);
	font-size: 12px;
	border-top: .5px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, .24));
	border-bottom: .5px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, .24));
}
.spc-head-actions {
	text-align: right;
}
.spc-list {
	position: relative;
	flex: 1;
	min-height: 0;
	overflow-y: auto;
}
.spc-canvas {
	position: relative;
}
.spc-row {
	position: absolute;
	left: 0;
	right: 0;
	box-sizing: border-box;
	display: grid;
	grid-template-columns: 28px minmax(0, 1fr) 96px 112px 132px 64px;
	align-items: center;
	gap: 8px;
	height: 44px;
	padding: 0 20px;
	border-bottom: .5px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, .18));
	font-size: 13px;
	line-height: 18px;
}
.spc-row:hover,
.spc-row-selected {
	background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .12));
}
.spc-row-archived .spc-rowtitle,
.spc-row-archived .spc-time,
.spc-row-archived .spc-workspace,
.spc-row-archived .spc-status {
	color: var(--dsw-alias-label-tertiary, #8e8e93);
}
.spc-title-cell {
	display: flex;
	align-items: center;
	gap: 6px;
	min-width: 0;
}
.spc-rowtitle {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.spc-badge {
	flex: none;
	padding: 0 6px;
	border: .5px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, .24));
	border-radius: 999px;
	color: var(--dsw-alias-label-tertiary, #8e8e93);
	font-size: 11px;
	line-height: 16px;
}
.spc-status {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	min-width: 0;
	color: var(--dsw-alias-label-secondary, #a1a1a6);
}
.spc-dot {
	flex: none;
	width: 8px;
	height: 8px;
	border-radius: 50%;
}
.spc-dot-ongoing {
	background: var(--dsw-alias-state-success-primary, #30d158);
}
.spc-dot-warning {
	background: var(--dsw-alias-state-warning-primary, #ff9f0a);
}
.spc-dot-idle {
	background: var(--dsw-alias-label-tertiary, #8e8e93);
	opacity: .55;
}
.spc-time {
	color: var(--dsw-alias-label-secondary, #a1a1a6);
	font-size: 12px;
	white-space: nowrap;
}
.spc-workspace {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	color: var(--dsw-alias-label-secondary, #a1a1a6);
	font-size: 12px;
}
.spc-rowactions {
	display: flex;
	align-items: center;
	justify-content: flex-end;
	gap: 2px;
	opacity: 0;
	transition: opacity .12s ease;
}
.spc-row:hover .spc-rowactions,
.spc-row:focus-within .spc-rowactions {
	opacity: 1;
}
.spc-iconbtn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 26px;
	height: 26px;
	padding: 0;
	border: none;
	border-radius: var(--dsw-radius-sm, 6px);
	background: transparent;
	color: var(--dsw-alias-label-secondary, #a1a1a6);
	cursor: pointer;
}
.spc-iconbtn:hover:not(:disabled) {
	background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .14));
	color: var(--dsw-alias-label-primary, #f5f5f7);
}
.spc-iconbtn-danger:hover:not(:disabled) {
	background: var(--dsw-alias-interactive-bg-hover-danger, rgba(229, 72, 77, .12));
	color: var(--dsw-alias-state-error-primary, #e5484d);
}
.spc-empty {
	position: absolute;
	inset: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	color: var(--dsw-alias-label-tertiary, #8e8e93);
	font-size: 13px;
	pointer-events: none;
}
.spc-bulk {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 10px 20px;
	border-top: .5px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, .24));
	background: var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, .06));
}
.spc-bulk-label {
	color: var(--dsw-alias-label-secondary, #a1a1a6);
	font-size: 13px;
}
.spc-spacer {
	flex: 1;
}
.spc-warn {
	color: var(--dsw-alias-state-error-primary, #e5484d);
}
.spc-check {
	display: flex;
	align-items: flex-start;
	gap: 8px;
	padding: 0 24px;
	color: var(--dsw-alias-label-primary, #f5f5f7);
	font-size: 13px;
	line-height: 20px;
	cursor: pointer;
}
.spc-check input {
	flex: none;
	margin: 2px 0 0;
	accent-color: var(--dsw-alias-state-error-primary, #e5484d);
}
.spc-dialog-wide {
	width: min(520px, 100%);
}
.spc-dialog-layer {
	z-index: 1100;
}
.spc-row input[type="checkbox"],
.spc-head input[type="checkbox"] {
	accent-color: var(--dsw-alias-button-primary-fill, #4c8dff);
}
`

		/* ------------------------------------------------------------------ *
		 * Data plumbing
		 * ------------------------------------------------------------------ */

		const EMPTY_SESSIONS = { ids: [], byId: {}, phase: 'idle', projectionsBySession: {} }
		const EMPTY_WORKSPACES = { items: [], pinnedSessionIds: [], archivedSessionIds: [] }
		const EMPTY_STATUSES = new Map()
		const EMPTY_PANEL_INFO = { activePanelId: null }

		// Fallbacks keep the hooks unconditional when a Host omits a standard prop.
		const fallbackUseSessions = (selector) => selector(EMPTY_SESSIONS)
		const fallbackUseWorkspaces = (selector) => selector(EMPTY_WORKSPACES)
		const fallbackUseSessionStatus = (selector) => selector(EMPTY_STATUSES)
		const fallbackUsePanelInfo = (selector) => selector(EMPTY_PANEL_INFO)

		function pickHook(value, fallback) {
			return typeof value === 'function' ? value : fallback
		}

		/** Same-origin URL for a Host route, anchored on the directory the Host serves. */
		function endpoint(path) {
			if (typeof document === 'undefined') return `/${path}`
			return new URL(path, document.baseURI).pathname
		}

		function errorText(t, error) {
			const message = error instanceof Error ? error.message : ''
			if (message === '') return t('error.unknown')
			if (/failed to fetch|networkerror|load failed|network request failed/i.test(message)) return t('error.network')
			return message
		}

		function nonEmpty(value) {
			return typeof value === 'string' && value.trim() !== '' ? value : undefined
		}

		/** Compact byte count for cleanup notices ("128 KB", "1.4 MB"). */
		function formatBytes(bytes) {
			if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 B'
			const units = ['B', 'KB', 'MB', 'GB']
			let value = bytes
			let unit = 0
			while (value >= 1024 && unit < units.length - 1) {
				value /= 1024
				unit += 1
			}
			const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(value >= 100 ? 0 : 1)
			return `${rounded} ${units[unit]}`
		}

		function readPrefs() {
			try {
				const raw = window.localStorage.getItem(STORAGE_KEY)
				if (raw === null) return { tab: 'all', sort: 'activity' }
				const parsed = JSON.parse(raw)
				return {
					tab: parsed?.tab === 'active' || parsed?.tab === 'archived' ? parsed.tab : 'all',
					sort: parsed?.sort === 'created' ? 'created' : 'activity',
				}
			} catch {
				return { tab: 'all', sort: 'activity' }
			}
		}

		function writePrefs(prefs) {
			try {
				window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ tab: prefs.tab, sort: prefs.sort }))
			} catch {
				// A blocked localStorage only loses the remembered filters.
			}
		}

		function absoluteTime(ms) {
			try {
				return new Date(ms).toLocaleString()
			} catch {
				return String(ms)
			}
		}

		function relativeTime(t, ms) {
			const delta = Date.now() - ms
			if (!Number.isFinite(delta)) return ''
			if (delta < 60_000) return t('time.justNow')
			const minutes = Math.floor(delta / 60_000)
			if (minutes < 60) return t('time.minutes', { count: minutes })
			const hours = Math.floor(minutes / 60)
			if (hours < 24) return t('time.hours', { count: hours })
			const days = Math.floor(hours / 24)
			if (days < 30) return t('time.days', { count: days })
			return absoluteTime(ms)
		}

		/**
		 * One row per top-level Session.
		 *
		 * Subagent children carry the parent's Session list entry under their own
		 * id; they are deleted with their parent and would be unsafe to delete on
		 * their own, so the console leaves them out.
		 */
		function buildRows(list, statuses, workspaces, createdAt) {
			const archivedIds = new Set(Array.isArray(workspaces?.archivedSessionIds) ? workspaces.archivedSessionIds : [])
			const workspaceBySession = new Map()
			const items = Array.isArray(workspaces?.items) ? workspaces.items : []
			for (const item of items) {
				const sessionIds = Array.isArray(item?.sessionIds) ? item.sessionIds : []
				const name = nonEmpty(item?.title) ?? nonEmpty(item?.path) ?? ''
				for (const id of sessionIds) {
					if (!workspaceBySession.has(id)) workspaceBySession.set(id, name)
				}
			}
			const rows = []
			const ids = Array.isArray(list?.ids) ? list.ids : []
			const byId = list?.byId !== null && typeof list?.byId === 'object' ? list.byId : {}
			for (const id of ids) {
				const snapshot = byId[id]
				if (snapshot === undefined || snapshot === null) continue
				if (snapshot.origin === 'subagent') continue
				if (snapshot.parentId !== undefined && snapshot.parentId !== null) continue
				const status = statuses instanceof Map ? statuses.get(id) : undefined
				const running = snapshot.running === true || status?.running === true
				const pendingInteraction = status?.pendingInteraction
				const pending = pendingInteraction !== undefined && pendingInteraction !== null
				const title = nonEmpty(snapshot.displayTitle) ?? nonEmpty(snapshot.title) ?? id
				rows.push({
					id,
					title,
					archived: archivedIds.has(id),
					workspace: workspaceBySession.get(id),
					running,
					pending,
					busy: running || pending,
					updatedAt: typeof snapshot.updatedAt === 'number' ? snapshot.updatedAt : undefined,
					createdAt: typeof createdAt?.[id] === 'number' ? createdAt[id] : undefined,
				})
			}
			return rows
		}

		function matchesQuery(row, query) {
			const needle = query.trim().toLowerCase()
			if (needle === '') return true
			if (row.title.toLowerCase().includes(needle)) return true
			if (row.id.toLowerCase().includes(needle)) return true
			return typeof row.workspace === 'string' && row.workspace.toLowerCase().includes(needle)
		}

		function sortRows(rows, sort) {
			const sorted = [...rows]
			if (sort === 'created') {
				sorted.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0) || (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
				return sorted
			}
			sorted.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
			return sorted
		}

		function countByTab(rows, query) {
			const searched = query === '' ? rows : rows.filter((row) => matchesQuery(row, query))
			let archived = 0
			for (const row of searched) if (row.archived) archived += 1
			return { all: searched.length, active: searched.length - archived, archived }
		}

		/** Request state shared by the menu row and the overlay: one purge at a time. */
		function createStore() {
			let value = null
			const listeners = new Set()
			return {
				get() {
					return value
				},
				set(next) {
					value = next
					for (const listener of [...listeners]) listener()
				},
				subscribe(listener) {
					listeners.add(listener)
					return () => listeners.delete(listener)
				},
			}
		}

		function useStore(store) {
			const [value, setValue] = React.useState(store.get())
			React.useEffect(() => {
				setValue(store.get())
				return store.subscribe(() => setValue(store.get()))
			}, [store])
			return value
		}

		function useDebounced(value, delay) {
			const [applied, setApplied] = React.useState(value)
			React.useEffect(() => {
				if (value === applied) return undefined
				const timer = setTimeout(() => setApplied(value), delay)
				return () => clearTimeout(timer)
			}, [value, delay, applied])
			return applied
		}

		/* ------------------------------------------------------------------ *
		 * Icons
		 * ------------------------------------------------------------------ */

		function CloseIcon() {
			return h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', 'aria-hidden': 'true', focusable: 'false' },
				h('path', {
					d: 'M2.5 2.5l9 9M11.5 2.5l-9 9',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.5,
					strokeLinecap: 'round',
				}))
		}

		function CheckIcon() {
			return h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', 'aria-hidden': 'true', focusable: 'false' },
				h('path', {
					d: 'M2.5 7.5l3 3 6.5-7',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.6,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
				}))
		}

		/**
		 * The Host's own trash outline, copied so this row sits at the same
		 * optical weight and size as the five rows above it.
		 */
		function TrashIcon() {
			return h('svg', {
				width: 14,
				height: 14,
				viewBox: '0 0 16 16',
				fill: 'none',
				strokeWidth: 1,
				'aria-hidden': 'true',
				focusable: 'false',
			},
				h('path', { d: 'M1.28149 3.88831H14.7187', stroke: 'currentColor' }),
				h('path', {
					d: 'M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833',
					stroke: 'currentColor',
				}),
				h('path', {
					d: 'M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831',
					stroke: 'currentColor',
				}),
				h('path', { d: 'M6.44946 6.98926V11.1238', stroke: 'currentColor' }),
				h('path', { d: 'M9.55054 6.98926V11.1238', stroke: 'currentColor' }),
			)
		}

		/** Archive box with an up arrow: the inverse of the Host's archive glyph. */
		function UnarchiveIcon() {
			return h('svg', {
				width: 14,
				height: 14,
				viewBox: '0 0 16 16',
				fill: 'none',
				strokeWidth: 1,
				'aria-hidden': 'true',
				focusable: 'false',
			},
				h('path', { d: 'M2 5h12v8.5H2z', stroke: 'currentColor' }),
				h('path', { d: 'M1.5 2.5h13V5h-13z', stroke: 'currentColor' }),
				h('path', { d: 'M8 11.5V7.5', stroke: 'currentColor' }),
				h('path', { d: 'M5.9 9.4L8 7.3l2.1 2.1', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round' }),
			)
		}

		/** The sidebar glyph: a panel holding the Session list. */
		function ConsoleIcon(props) {
			const size = typeof props?.size === 'number' ? props.size : 16
			return h('svg', {
				width: size,
				height: size,
				viewBox: '0 0 16 16',
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: 1,
				'aria-hidden': 'true',
				focusable: 'false',
			},
				h('rect', { x: 2.25, y: 2.25, width: 11.5, height: 11.5, rx: 2.5 }),
				h('path', { d: 'M4.9 6.1h6.2', strokeLinecap: 'round' }),
				h('path', { d: 'M4.9 8.4h6.2', strokeLinecap: 'round' }),
				h('path', { d: 'M4.9 10.7h3.8', strokeLinecap: 'round' }),
			)
		}

		/** The housekeeping affordance: three dots, the same shape the Host menus use. */
		function MoreIcon() {
			return h('svg', {
				width: 16,
				height: 16,
				viewBox: '0 0 16 16',
				fill: 'currentColor',
				'aria-hidden': 'true',
				focusable: 'false',
			},
				h('circle', { cx: 3.4, cy: 8, r: 1.2 }),
				h('circle', { cx: 8, cy: 8, r: 1.2 }),
				h('circle', { cx: 12.6, cy: 8, r: 1.2 }),
			)
		}

		/* ------------------------------------------------------------------ *
		 * The Session "…" menu row
		 * ------------------------------------------------------------------ */

		/**
		 * `useMenuOpenState` is a slot hook, so it is present for every entry of
		 * this slot and its identity never changes for one occurrence; guarding it
		 * keeps a Host that drops the hook from crashing the sidebar.
		 */
		function closingHook(useMenuOpenState) {
			if (typeof useMenuOpenState !== 'function') return undefined
			const [, setMenuOpen] = useMenuOpenState()
			return setMenuOpen
		}

		function PurgeMenuItem(props) {
			const setMenuOpen = closingHook(props.useMenuOpenState)
			return h('div', { className: 'sp-menuRow' },
				h('div', { className: 'sp-menuSeparator', role: 'separator' }),
				h('button', {
					type: 'button',
					role: 'menuitem',
					className: 'sp-menuItem',
					onClick: () => {
						if (setMenuOpen !== undefined) setMenuOpen(false)
						props.store.set({
							sessionId: props.sessionId,
							displayTitle: props.displayTitle === undefined || props.displayTitle === '' ? props.sessionId : props.displayTitle,
							phase: 'confirm',
							message: '',
							archived: false,
						})
					},
				},
					h('span', { className: 'sp-menuIcon' }, h(TrashIcon, null)),
					h('span', { className: 'sp-menuLabel' }, props.t('menu.purgeSession')),
				),
			)
		}

		/* ------------------------------------------------------------------ *
		 * The single-Session confirmation
		 * ------------------------------------------------------------------ */

		function PurgeOverlay(props) {
			const request = useStore(props.store)
			if (request === null) return null
			if (request.phase === 'done') return h(PurgeToast, { t: props.t, request })
			return h(PurgeDialog, { t: props.t, request, store: props.store, run: props.run })
		}

		function PurgeToast({ t, request }) {
			return h('div', { className: 'sp-toast', role: 'status' },
				h('span', { className: 'sp-toast-icon' }, h(CheckIcon, null)),
				h('span', { className: 'sp-toast-text' }, t('toast.done', { title: request.displayTitle })),
			)
		}

		function PurgeDialog({ t, request, store, run }) {
			const cancelRef = React.useRef(null)
			const running = request.phase === 'running'

			const dismiss = React.useCallback(() => {
				if (!running) store.set(null)
			}, [running, store])

			React.useEffect(() => {
				if (cancelRef.current !== null) cancelRef.current.focus()
			}, [])

			const onKeyDown = (event) => {
				if (event.key === 'Escape') {
					if (running) return
					event.preventDefault()
					event.stopPropagation()
					dismiss()
					return
				}
				if (event.key !== 'Tab') return
				const buttons = Array.from(event.currentTarget.querySelectorAll('button:not([disabled])'))
				if (buttons.length === 0) return
				const first = buttons[0]
				const last = buttons[buttons.length - 1]
				if (event.shiftKey && document.activeElement === first) {
					event.preventDefault()
					last.focus()
				} else if (!event.shiftKey && document.activeElement === last) {
					event.preventDefault()
					first.focus()
				}
			}

			const titleId = `sp-title-${request.sessionId}`
			const descriptionId = `sp-desc-${request.sessionId}`

			return h('div', { className: 'sp-layer' },
				h('div', { className: 'sp-mask', onClick: dismiss }),
				h('div', {
					className: 'sp-dialog',
					role: 'dialog',
					'aria-modal': 'true',
					'aria-labelledby': titleId,
					'aria-describedby': descriptionId,
					onKeyDown,
				},
					h('div', { className: 'sp-header' },
						h('h2', { className: 'sp-title', id: titleId }, t('dialog.title')),
						h('button', {
							type: 'button',
							className: 'sp-close',
							'aria-label': t('dialog.close'),
							disabled: running,
							onClick: dismiss,
						}, h(CloseIcon, null)),
					),
					h('p', { className: 'sp-description', id: descriptionId }, t('dialog.description')),
					h('div', { className: 'sp-body' },
						h('div', { className: 'sp-target' },
							h('span', { className: 'sp-target-title' }, request.displayTitle),
							h('span', { className: 'sp-target-id' }, request.sessionId),
						),
						running ? h('div', { className: 'sp-status', role: 'status' }, t('dialog.running')) : null,
						request.phase === 'error' ? h('div', { className: 'sp-error', role: 'alert' },
							t(request.archived ? 'dialog.failedArchived' : 'dialog.failed', { message: request.message }),
						) : null,
					),
					h('div', { className: 'sp-footer' },
						h('button', {
							ref: cancelRef,
							type: 'button',
							className: 'sp-button',
							disabled: running,
							onClick: dismiss,
						}, t('dialog.cancel')),
						h('button', {
							type: 'button',
							className: 'sp-button sp-danger sp-danger-solid',
							disabled: running,
							onClick: () => { void run(request) },
						}, t('dialog.confirm')),
					),
				),
			)
		}

		/* ------------------------------------------------------------------ *
		 * The sidebar panel: a `main` placeholder plus the console overlay
		 * ------------------------------------------------------------------ */

		/**
		 * The sidebar's icon column selects a `main` key; a missing key throws in
		 * the Host, so this panel must exist. The console itself renders in
		 * `shell.overlay`, above the frame, so the panel stays empty.
		 */
		function ConsoleGate() {
			return null
		}

		function ConsolePanelIcon(props) {
			return h(ConsoleIcon, { size: typeof props?.size === 'number' ? props.size : 16 })
		}

		function ConsoleOverlay(props) {
			const usePanelInfo = pickHook(props.usePanelInfo, fallbackUsePanelInfo)
			const active = usePanelInfo((info) => info !== null && info !== undefined && info.activePanelId === PANEL_ID)
			if (active !== true) return null
			return h(ConsolePage, props)
		}

		function ConsolePage(props) {
			const t = props.t
			const api = props.consoleApi
			const useSessions = pickHook(props.useSessions, fallbackUseSessions)
			const useWorkspaces = pickHook(props.useWorkspaces, fallbackUseWorkspaces)
			const useSessionStatus = pickHook(props.useSessionStatus, fallbackUseSessionStatus)

			const list = useSessions((state) => state)
			const workspaces = useWorkspaces((state) => state)
			const statuses = useSessionStatus((state) => state)

			const prefs = React.useMemo(readPrefs, [])
			const [tab, setTab] = React.useState(prefs.tab)
			const [sort, setSort] = React.useState(prefs.sort)
			const [input, setInput] = React.useState('')
			const query = useDebounced(input, SEARCH_DELAY_MS)
			const [selected, setSelected] = React.useState(() => new Set())
			const [createdAt, setCreatedAt] = React.useState({})
			const [dialog, setDialog] = React.useState(null)
			const [progress, setProgress] = React.useState(null)
			const [failures, setFailures] = React.useState([])
			const [notice, setNotice] = React.useState('')
			const [actionError, setActionError] = React.useState('')
			const [moreOpen, setMoreOpen] = React.useState(false)
			const [upkeepBusy, setUpkeepBusy] = React.useState(false)

			const searchRef = React.useRef(null)
			const listRef = React.useRef(null)
			const menuRef = React.useRef(null)
			const panelRef = React.useRef(null)
			const [scrollTop, setScrollTop] = React.useState(0)
			const [viewport, setViewport] = React.useState(420)

			const rows = React.useMemo(
				() => buildRows(list, statuses, workspaces, createdAt),
				[list, statuses, workspaces, createdAt],
			)
			const rowById = React.useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows])
			const counts = React.useMemo(() => countByTab(rows, query), [rows, query])
			const visible = React.useMemo(() => {
				const byTab = rows.filter((row) => (tab === 'archived' ? row.archived : tab === 'active' ? !row.archived : true))
				const searched = query === '' ? byTab : byTab.filter((row) => matchesQuery(row, query))
				return sortRows(searched, sort)
			}, [rows, tab, query, sort])

			React.useEffect(() => {
				writePrefs({ tab, sort })
			}, [tab, sort])

			// A new view invalidates the old selection: keeping it would let a bulk
			// delete hit rows the user can no longer see.
			React.useEffect(() => {
				setSelected(new Set())
			}, [tab, query])

			const refreshInventory = React.useCallback(() => {
				let alive = true
				api.inventory().then((map) => {
					if (alive) setCreatedAt(map)
				}).catch(() => {
					// Creation times are optional; sorting falls back to last activity.
				})
				return () => { alive = false }
			}, [api])

			React.useEffect(() => refreshInventory(), [refreshInventory])

			React.useEffect(() => {
				if (notice === '') return undefined
				const timer = setTimeout(() => setNotice(''), NOTICE_MS)
				return () => clearTimeout(timer)
			}, [notice])

			React.useEffect(() => {
				if (searchRef.current !== null) searchRef.current.focus()
			}, [])

			React.useEffect(() => {
				const node = listRef.current
				if (node === null) return undefined
				const measure = () => setViewport(node.clientHeight)
				measure()
				if (typeof ResizeObserver === 'function') {
					const observer = new ResizeObserver(measure)
					observer.observe(node)
					return () => observer.disconnect()
				}
				window.addEventListener('resize', measure)
				return () => window.removeEventListener('resize', measure)
			}, [])

			React.useEffect(() => {
				setScrollTop(0)
				if (listRef.current !== null) listRef.current.scrollTop = 0
			}, [tab, query])

			// "3 minutes ago" is only true for a minute. Re-render on a slow tick so a
			// console left open does not keep showing a frozen timestamp.
			const [, setClock] = React.useState(0)
			React.useEffect(() => {
				const timer = setInterval(() => setClock((value) => value + 1), CLOCK_MS)
				return () => clearInterval(timer)
			}, [])

			// Clicking anywhere else has to close the cleanup menu: an open menu that
			// survives a click on the row underneath it looks like a stuck popup.
			React.useEffect(() => {
				if (!moreOpen) return undefined
				const onPointerDown = (event) => {
					const root = menuRef.current
					if (root !== null && event.target instanceof Node && root.contains(event.target)) return
					setMoreOpen(false)
				}
				document.addEventListener('pointerdown', onPointerDown, true)
				return () => document.removeEventListener('pointerdown', onPointerDown, true)
			}, [moreOpen])

			const total = visible.length * ROW_HEIGHT
			const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
			const end = Math.min(visible.length, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN)
			const slice = visible.slice(start, end)

			const toggleSelected = React.useCallback((id) => {
				setSelected((current) => {
					const next = new Set(current)
					if (next.has(id)) next.delete(id)
					else next.add(id)
					return next
				})
			}, [])

			const selectAllVisible = React.useCallback(() => {
				setSelected(new Set(visible.map((row) => row.id)))
			}, [visible])

			const clearSelection = React.useCallback(() => {
				setSelected(new Set())
			}, [])

			const titleOf = React.useCallback((id) => {
				const row = rowById.get(id)
				return row === undefined ? id : row.title
			}, [rowById])

			const unarchiveRow = React.useCallback(async (id) => {
				setActionError('')
				try {
					await api.unarchive(id)
				} catch (error) {
					setActionError(t('console.error.unarchive', { message: errorText(t, error) }))
				}
			}, [api, t])

			const requestPurge = React.useCallback((ids) => {
				if (!Array.isArray(ids) || ids.length === 0) return
				setActionError('')
				setDialog({ ids: [...ids] })
			}, [])

			/**
			 * Run one housekeeping sweep.
			 *
			 * Neither sweep can lose a Session: the Host skips every id it still
			 * knows about, and the folder sweep only removes folders that are
			 * already empty. The result is reported in the console's notice bar.
			 */
			const runUpkeep = React.useCallback(async (kind) => {
				if (upkeepBusy) return
				setMoreOpen(false)
				setUpkeepBusy(true)
				setActionError('')
				setNotice('')
				try {
					const result = await api.upkeep(kind)
					if (result.skipped !== undefined) {
						setActionError(t('console.upkeep.skipped', { reason: result.skipped }))
					} else if (result.removed === 0) {
						setNotice(t('console.upkeep.none'))
					} else if (kind === 'cache') {
						setNotice(t('console.upkeep.cacheDone', {
							count: result.removed,
							size: formatBytes(result.freedBytes),
						}))
					} else {
						setNotice(t('console.upkeep.directoriesDone', { count: result.removed }))
					}
				} catch (error) {
					setActionError(t('console.error.upkeep', { message: errorText(t, error) }))
				} finally {
					setUpkeepBusy(false)
				}
			}, [api, t, upkeepBusy])

			const upkeepItem = (kind, labelKey, hintKey) => h('button', {
				key: kind,
				type: 'button',
				role: 'menuitem',
				className: 'spc-more-item',
				disabled: upkeepBusy,
				onClick: () => { void runUpkeep(kind) },
			},
				h('span', null, t(labelKey)),
				h('span', { className: 'spc-more-hint' }, t(hintKey)),
			)
			const execute = React.useCallback(async (ids) => {
				setDialog(null)
				setFailures([])
				setNotice('')
				setProgress({ index: 1, total: ids.length, sessionId: ids[0], title: titleOf(ids[0]) })
				const result = await api.purgeMany(ids, (info) => {
					setProgress({ index: info.index, total: ids.length, sessionId: info.sessionId, title: titleOf(info.sessionId) })
				})
				setProgress(null)
				setFailures(result.failures)
				const deleted = ids.length - result.failures.length
				setNotice(result.failures.length === 0
					? t('console.progress.done', { count: deleted })
					: t('console.progress.partial', { done: deleted, failed: result.failures.length }))
				setSelected(new Set())
				refreshInventory()
			}, [api, refreshInventory, t, titleOf])

			const onKeyDown = (event) => {
				if (event.key === 'Tab') {
					// Keep the Tab ring inside the panel; the confirm dialogs have their own.
					if (dialog !== null || progress !== null) return
					const root = panelRef.current
					if (root === null) return
					const focusable = [...root.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
						.filter((node) => node.offsetParent !== null || node === document.activeElement)
					if (focusable.length === 0) return
					const first = focusable[0]
					const last = focusable[focusable.length - 1]
					if (event.shiftKey && document.activeElement === first) {
						event.preventDefault()
						last.focus()
					} else if (!event.shiftKey && document.activeElement === last) {
						event.preventDefault()
						first.focus()
					}
					return
				}
				if (event.key !== 'Escape') return
				if (moreOpen) {
					event.stopPropagation()
					setMoreOpen(false)
					return
				}
				if (dialog !== null || progress !== null) return
				event.stopPropagation()
				api.close()
			}

			const allSelected = visible.length > 0 && visible.every((row) => selected.has(row.id))
			const emptyText = query !== ''
				? t('console.empty.search')
				: tab === 'archived' ? t('console.empty.archived')
					: tab === 'active' ? t('console.empty.active')
						: t('console.empty.all')

			const tabButton = (value) => h('button', {
				key: value,
				type: 'button',
				role: 'tab',
				className: 'spc-tab',
				'aria-selected': tab === value,
				onClick: () => setTab(value),
			},
				h('span', null, t(`console.tab.${value}`)),
				h('span', { className: 'spc-count' }, String(counts[value])),
			)

			return h('div', { className: 'spc-layer' },
				h('div', {
					className: 'spc-mask',
					onClick: () => {
						if (dialog === null && progress === null) api.close()
					},
				}),
				h('section', {
					className: 'spc-panel',
					ref: panelRef,
					role: 'dialog',
					'aria-modal': 'true',
					'aria-label': t('console.title'),
					onKeyDown,
				},
					h('header', { className: 'spc-header' },
						h('h2', { className: 'spc-title' }, t('console.title')),
						h('div', { className: 'spc-header-actions' },
							h('div', { className: 'spc-more', ref: menuRef },
								h('button', {
									type: 'button',
									className: 'spc-more-button',
									title: t('console.more'),
									'aria-label': t('console.more'),
									'aria-haspopup': 'menu',
									'aria-expanded': moreOpen,
									disabled: upkeepBusy,
									onClick: () => setMoreOpen(!moreOpen),
								}, h(MoreIcon, null)),
								moreOpen ? h('div', { className: 'spc-more-menu', role: 'menu' },
									upkeepItem('cache', 'console.more.cache', 'console.more.cacheHint'),
									upkeepItem('directories', 'console.more.directories', 'console.more.directoriesHint'),
								) : null,
							),
							h('button', {
								type: 'button',
								className: 'sp-close',
								'aria-label': t('console.close'),
								onClick: api.close,
							}, h(CloseIcon, null)),
						),
					),
					h('div', { className: 'spc-toolbar' },
						h('div', { className: 'spc-tabs', role: 'tablist' }, tabButton('all'), tabButton('active'), tabButton('archived')),
						h('input', {
							ref: searchRef,
							className: 'spc-search',
							type: 'search',
							value: input,
							placeholder: t('console.search'),
							'aria-label': t('console.search'),
							onChange: (event) => setInput(event.target.value),
						}),
						h('label', { className: 'spc-sort' },
							h('span', null, t('console.sort.label')),
							h('select', {
								className: 'spc-select',
								value: sort,
								'aria-label': t('console.sort.label'),
								onChange: (event) => setSort(event.target.value === 'created' ? 'created' : 'activity'),
							},
								h('option', { value: 'activity' }, t('console.sort.activity')),
								h('option', { value: 'created' }, t('console.sort.created')),
							),
						),
					),
					notice !== '' ? h('div', { className: 'spc-notice', role: 'status' }, notice) : null,
					actionError !== '' ? h('div', { className: 'spc-alert', role: 'alert' }, actionError) : null,
					failures.length > 0 ? h('div', { className: 'spc-alert', role: 'alert' },
						failures.map((failure) => h('div', { key: failure.sessionId },
							t(failure.archived === true ? 'console.failedRowArchived' : 'console.failedRow', {
								message: `${titleOf(failure.sessionId)} — ${failure.message}`,
							}),
						)),
					) : null,
					h('div', {
						className: 'spc-table',
						role: 'table',
						'aria-label': t('console.title'),
						'aria-rowcount': visible.length + 1,
						'aria-colcount': 6,
					},
						h('div', { className: 'spc-head', role: 'row', 'aria-rowindex': 1 },
							h('span', { role: 'columnheader' }, h('input', {
								type: 'checkbox',
								checked: allSelected,
								disabled: visible.length === 0,
								'aria-label': t('console.selectAll'),
								onChange: () => {
									if (allSelected) clearSelection()
									else selectAllVisible()
								},
							})),
							h('span', { role: 'columnheader' }, t('console.col.title')),
							h('span', { role: 'columnheader' }, t('console.col.status')),
							h('span', { role: 'columnheader' }, t('console.col.updated')),
							h('span', { role: 'columnheader' }, t('console.col.workspace')),
							h('span', { role: 'columnheader', className: 'spc-head-actions' }, t('console.col.actions')),
						),
						h('div', {
							className: 'spc-list',
							ref: listRef,
							role: 'rowgroup',
							onScroll: (event) => setScrollTop(event.currentTarget.scrollTop),
						},
							h('div', { className: 'spc-canvas', style: { height: `${Math.max(total, 1)}px` } },
								slice.map((row, offset) => h(ConsoleRowView, {
									key: row.id,
									row,
									t,
									selected: selected.has(row.id),
									rowIndex: start + offset + 2,
									onToggle: toggleSelected,
									onUnarchive: (id) => { void unarchiveRow(id) },
									onPurge: (id) => requestPurge([id]),
									style: { top: `${(start + offset) * ROW_HEIGHT}px` },
								})),
							),
							visible.length === 0 ? h('div', { className: 'spc-empty' }, emptyText) : null,
						),
					),
					selected.size > 0 ? h('div', { className: 'spc-bulk' },
						h('span', { className: 'spc-bulk-label' }, t('console.selectedCount', { count: selected.size })),
						h('button', { type: 'button', className: 'sp-button sp-button-sm', onClick: selectAllVisible }, t('console.selectAll')),
						h('button', { type: 'button', className: 'sp-button sp-button-sm', onClick: clearSelection }, t('console.clearSelection')),
						h('span', { className: 'spc-spacer' }),
						h('button', {
							type: 'button',
							className: 'sp-button sp-button-sm sp-danger sp-danger-solid',
							onClick: () => requestPurge([...selected]),
						}, t('console.bulkPurge')),
					) : null,
				),
				dialog !== null ? h(ConsoleConfirm, {
					t,
					ids: dialog.ids,
					rowById,
					onCancel: () => setDialog(null),
					onConfirm: (ids) => { void execute(ids) },
				}) : null,
				progress !== null ? h(ConsoleProgress, { t, progress }) : null,
			)
		}

		function ConsoleRowView({ row, t, selected, rowIndex, onToggle, onUnarchive, onPurge, style }) {
			const statusClass = row.running ? 'spc-dot-ongoing' : row.pending ? 'spc-dot-warning' : 'spc-dot-idle'
			const statusText = row.running
				? t('console.status.running')
				: row.pending ? t('console.status.pending') : t('console.status.idle')
			const className = row.archived ? `spc-row spc-row-archived${selected ? ' spc-row-selected' : ''}` : `spc-row${selected ? ' spc-row-selected' : ''}`
			return h('div', {
				className,
				style,
				role: 'row',
				'aria-selected': selected,
				'aria-rowindex': rowIndex,
			},
				h('span', { role: 'cell' }, h('input', {
					type: 'checkbox',
					checked: selected,
					'aria-label': row.title,
					onChange: () => onToggle(row.id),
				})),
				h('span', { className: 'spc-title-cell', role: 'cell' },
					h('span', { className: 'spc-rowtitle', title: row.title }, row.title),
					row.archived ? h('span', { className: 'spc-badge' }, t('console.archivedBadge')) : null,
				),
				h('span', { className: 'spc-status', role: 'cell' },
					h('span', { className: `spc-dot ${statusClass}`, 'aria-hidden': 'true' }),
					h('span', null, statusText),
				),
				h('span', {
					className: 'spc-time',
					role: 'cell',
					title: row.updatedAt === undefined ? '' : absoluteTime(row.updatedAt),
				}, row.updatedAt === undefined ? '' : relativeTime(t, row.updatedAt)),
				h('span', {
					className: 'spc-workspace',
					role: 'cell',
					title: row.workspace ?? t('console.noWorkspace'),
				}, row.workspace ?? t('console.noWorkspace')),
				h('span', { className: 'spc-rowactions', role: 'cell' },
					row.archived ? h('button', {
						type: 'button',
						className: 'spc-iconbtn',
						title: t('console.action.unarchive'),
						'aria-label': t('console.action.unarchive'),
						onClick: () => onUnarchive(row.id),
					}, h(UnarchiveIcon, null)) : null,
					h('button', {
						type: 'button',
						className: 'spc-iconbtn spc-iconbtn-danger',
						title: t('console.action.purge'),
						'aria-label': t('console.action.purge'),
						onClick: () => onPurge(row.id),
					}, h(TrashIcon, null)),
				),
			)
		}

		function ConsoleConfirm({ t, ids, rowById, onCancel, onConfirm }) {
			const [force, setForce] = React.useState(false)
			const [aware, setAware] = React.useState(false)
			const cancelRef = React.useRef(null)
			const running = ids.filter((id) => rowById.get(id)?.busy === true).length
			const needForce = running > 0
			const needAware = ids.length > 10
			const canConfirm = (!needForce || force) && (!needAware || aware)
			const title = ids.length === 1
				? t('console.confirm.title.one', { title: rowById.get(ids[0])?.title ?? ids[0] })
				: t('console.confirm.title.many', { count: ids.length })

			React.useEffect(() => {
				if (cancelRef.current !== null) cancelRef.current.focus()
			}, [])

			const onKeyDown = (event) => {
				if (event.key === 'Escape') {
					event.preventDefault()
					event.stopPropagation()
					onCancel()
					return
				}
				if (event.key !== 'Tab') return
				const buttons = Array.from(event.currentTarget.querySelectorAll('button:not([disabled]), input:not([disabled])'))
				if (buttons.length === 0) return
				const first = buttons[0]
				const last = buttons[buttons.length - 1]
				if (event.shiftKey && document.activeElement === first) {
					event.preventDefault()
					last.focus()
				} else if (!event.shiftKey && document.activeElement === last) {
					event.preventDefault()
					first.focus()
				}
			}

			return h('div', { className: 'sp-layer spc-dialog-layer' },
				h('div', { className: 'sp-mask', onClick: onCancel }),
				h('div', {
					className: 'sp-dialog spc-dialog-wide',
					role: 'dialog',
					'aria-modal': 'true',
					'aria-label': title,
					onKeyDown,
				},
					h('div', { className: 'sp-header' },
						h('h2', { className: 'sp-title' }, title),
						h('button', {
							type: 'button',
							className: 'sp-close',
							'aria-label': t('dialog.close'),
							onClick: onCancel,
						}, h(CloseIcon, null)),
					),
					h('p', { className: 'sp-description' }, t('console.confirm.desc')),
					needForce ? h('p', { className: 'sp-description spc-warn' },
						t('console.confirm.running', { count: ids.length, running }),
					) : null,
					needForce ? h('label', { className: 'spc-check' },
						h('input', {
							type: 'checkbox',
							checked: force,
							onChange: (event) => setForce(event.target.checked),
						}),
						h('span', null, t('console.confirm.force')),
					) : null,
					needAware ? h('label', { className: 'spc-check' },
						h('input', {
							type: 'checkbox',
							checked: aware,
							onChange: (event) => setAware(event.target.checked),
						}),
						h('span', null, t('console.confirm.irreversible')),
					) : null,
					h('div', { className: 'sp-footer' },
						h('button', {
							ref: cancelRef,
							type: 'button',
							className: 'sp-button',
							onClick: onCancel,
						}, t('console.confirm.cancel')),
						h('button', {
							type: 'button',
							className: 'sp-button sp-danger sp-danger-solid',
							disabled: !canConfirm,
							onClick: () => onConfirm(ids),
						}, t('console.confirm.action')),
					),
				),
			)
		}

		function ConsoleProgress({ t, progress }) {
			return h('div', { className: 'sp-layer spc-dialog-layer' },
				h('div', { className: 'sp-mask' }),
				h('div', {
					className: 'sp-dialog',
					role: 'dialog',
					'aria-modal': 'true',
					'aria-label': t('console.progress.title', { count: progress.total }),
				},
					h('div', { className: 'sp-header' },
						h('h2', { className: 'sp-title' }, t('console.progress.title', { count: progress.total })),
					),
					h('div', { className: 'sp-body' },
						h('div', { className: 'sp-status', role: 'status' },
							t('console.progress.stopping', { done: progress.index, total: progress.total }),
						),
						progress.title === undefined ? null : h('div', { className: 'sp-target' },
							h('span', { className: 'sp-target-title' }, progress.title),
							h('span', { className: 'sp-target-id' }, progress.sessionId),
						),
					),
				),
			)
		}

		return {
			name: NS,
			inject: ['slots', 'locale'],
			apply(ctx) {
				const store = createStore()
				const t = ctx.locale.bind(NS)

				ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), `${NS}: dictionaries`)

				ctx.effect(() => {
					const tag = document.createElement('style')
					tag.dataset.plugin = NS
					tag.dataset.pluginCss = `${NS}/client`
					tag.textContent = CSS
					document.head.appendChild(tag)
					return () => tag.remove()
				}, `${NS}: styles`)

				function clientService(key) {
					try {
						return ctx.get(key)
					} catch {
						return undefined
					}
				}

				/**
				 * Delete one Session: let the Host let go of it, then have the Host
				 * half remove every trace. Reports whether the archive step ran, so a
				 * failure can tell the user the row is now only archived.
				 */
				async function purgeSession(sessionId, onArchived) {
					const uiWorkspace = clientService('uiWorkspace')
					let archived = false
					if (uiWorkspace !== undefined && typeof uiWorkspace.archiveSession === 'function') {
						try {
							await uiWorkspace.archiveSession(sessionId, { stopActivity: true })
							archived = true
						} catch {
							// Unknown or already-archived sessions have nothing to archive.
						}
					}
					if (typeof onArchived === 'function') onArchived(archived)

					const response = await fetch(endpoint(PURGE_PATH), {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ sessionId }),
					})
					let body
					try {
						body = await response.json()
					} catch {
						body = undefined
					}
					if (!response.ok || body === undefined || body.ok !== true) {
						const detail = typeof body?.message === 'string' && body.message !== ''
							? body.message
							: `HTTP ${response.status}`
						throw new Error(detail)
					}

					// The row must go even when the Host had no live Session entry to
					// release; the list is refreshed from the Host elsewhere, so drop it here.
					const sessions = clientService('sessions')
					if (sessions !== undefined && typeof sessions.handleSessionRemoved === 'function') {
						try {
							sessions.handleSessionRemoved(sessionId)
						} catch {
							// A stale list entry is cosmetic; the deletion already happened.
						}
					}
					return archived
				}

				async function run(request) {
					const target = { sessionId: request.sessionId, displayTitle: request.displayTitle }
					store.set({ ...target, phase: 'running', message: '', archived: false })
					let archived = false
					try {
						archived = await purgeSession(request.sessionId, (value) => { archived = value })
						store.set({ ...target, phase: 'done', message: '', archived })
						setTimeout(() => {
							const current = store.get()
							if (current !== null && current.phase === 'done' && current.sessionId === target.sessionId) store.set(null)
						}, TOAST_MS)
					} catch (error) {
						store.set({ ...target, phase: 'error', message: errorText(t, error), archived })
					}
				}

				async function purgeMany(ids, report) {
					const failures = []
					for (let index = 0; index < ids.length; index += 1) {
						const sessionId = ids[index]
						if (typeof report === 'function') report({ index: index + 1, total: ids.length, sessionId })
						// A failed delete leaves the row archived, not untouched: the archive
						// step runs first so the Host can stop the Session. Record that, or the
						// console would claim nothing changed.
						let archived = false
						try {
							await purgeSession(sessionId, (value) => { archived = value })
						} catch (error) {
							failures.push({ sessionId, message: errorText(t, error), archived })
						}
					}
					// The console is one view of a shared list: pull the Host's truth once
					// the batch is over so the sidebar, its archive filter and the counts
					// agree with what was deleted.
					const sessions = clientService('sessions')
					if (sessions !== undefined && typeof sessions.refresh === 'function') {
						try {
							await sessions.refresh()
						} catch {
							// The local removals already dropped the rows that did delete.
						}
					}
					return { failures }
				}

				async function inventory() {
					const response = await fetch(endpoint(INVENTORY_PATH), { method: 'GET', headers: { accept: 'application/json' } })
					let body
					try {
						body = await response.json()
					} catch {
						body = undefined
					}
					if (!response.ok || body === undefined || body.ok !== true) {
						throw new Error(`HTTP ${response.status}`)
					}
					const map = {}
					for (const entry of Array.isArray(body.sessions) ? body.sessions : []) {
						if (typeof entry?.id !== 'string' || typeof entry.createdAt !== 'number') continue
						map[entry.id] = entry.createdAt
					}
					return map
				}

				/**
				 * Ask the Host to sweep unsessioned debris.
				 *
				 * `kind` picks the route: `cache` drops projection-cache records whose
				 * Session is gone, `directories` removes empty project folders. Both
				 * answer the same shape, including `skipped` when this Host cannot do
				 * the sweep at all.
				 */
				async function upkeep(kind) {
					const path = kind === 'directories' ? DIRECTORY_UPKEEP_PATH : CACHE_UPKEEP_PATH
					const response = await fetch(endpoint(path), {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: '{}',
					})
					let body
					try {
						body = await response.json()
					} catch {
						body = undefined
					}
					if (!response.ok || body === undefined || body.ok !== true) {
						const detail = typeof body?.message === 'string' && body.message !== ''
							? body.message
							: `HTTP ${response.status}`
						throw new Error(detail)
					}
					return {
						removed: typeof body.removed === 'number' ? body.removed : 0,
						freedBytes: typeof body.freedBytes === 'number' ? body.freedBytes : 0,
						skipped: typeof body.skipped === 'string' ? body.skipped : undefined,
					}
				}

				async function unarchiveSession(sessionId) {
					const uiWorkspace = clientService('uiWorkspace')
					if (uiWorkspace !== undefined && typeof uiWorkspace.unarchiveSession === 'function') {
						await uiWorkspace.unarchiveSession(sessionId)
						return
					}
					const workspaces = clientService('workspaces')
					if (workspaces === undefined || typeof workspaces.unarchiveSession !== 'function') {
						throw new Error('unarchive is unavailable')
					}
					await workspaces.unarchiveSession(sessionId)
				}

				const consoleApi = {
					close() {
						const layout = clientService('layout')
						if (layout === undefined || typeof layout.selectPanel !== 'function') return
						try {
							layout.selectPanel(null)
						} catch {
							// Already showing the Conversation.
						}
					},
					unarchive: unarchiveSession,
					purgeMany,
					inventory,
					upkeep,
				}

				ctx.slots.inject(SESSION_MENU, () => ctx.slots.register({
					name: SESSION_MENU,
					id: `${NS}.menu`,
					order: 500,
					locale: NS,
					inject: () => ({ store }),
				}, PurgeMenuItem))

				ctx.slots.inject(OVERLAY, () => ctx.slots.register({
					name: OVERLAY,
					id: `${NS}.overlay`,
					order: 60,
					label: () => 'Session Manager',
					locale: NS,
					inject: () => ({ store, run, consoleApi }),
				}, PurgeOverlay))

				// The console is a floating page, but the sidebar's icon column only
				// selects `main` keys, so both halves of the entry must exist.
				ctx.slots.inject(MAIN, () => ctx.slots.register({
					name: MAIN,
					key: PANEL_ID,
					locale: NS,
				}, ConsoleGate))

				ctx.slots.inject(PANELLIST, () => ctx.slots.register({
					name: PANELLIST,
					id: PANEL_ID,
					order: 5,
					label: () => t('panel.title'),
					locale: NS,
				}, ConsolePanelIcon))

				ctx.slots.inject(OVERLAY, () => ctx.slots.register({
					name: OVERLAY,
					id: `${NS}.console`,
					order: 70,
					label: () => 'Session Console',
					locale: NS,
					inject: () => ({ consoleApi }),
				}, ConsoleOverlay))
			},
		}
	},
})
