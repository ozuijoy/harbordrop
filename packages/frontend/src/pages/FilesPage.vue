<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { previewKind } from "@harbordrop/shared";
import { HdApiError } from "@harbordrop/shared/upload";
import { session } from "../api";
import { t, formatBytes, formatTime } from "../i18n";
import { previewComponent, MarkdownPreview } from "../previews";
import { fs, downloadUrl, enqueue, enqueueDropped, enqueueFolder, queue, retryItem, retryAllFailed, cancelItem, clearFinished, onUploaded, isPasswordError, type FsEntry, type FsListResponse } from "../fs/client";
import { collectFolderFiles, filesFromDataTransfer } from "../folder";

const route = useRoute();
const router = useRouter();

/** /files/a/b → /a/b */
const vpath = computed(() => {
  const p = route.params.path;
  const parts = (Array.isArray(p) ? p : p ? [p] : []).filter(Boolean);
  return "/" + parts.join("/");
});
const toRoute = (vp: string) => "/files" + (vp === "/" ? "" : vp.split("/").map(encodeURIComponent).join("/"));
const crumbs = computed(() => {
  const parts = vpath.value.split("/").filter(Boolean);
  return [{ name: t("files.root"), path: "/" }, ...parts.map((n, i) => ({ name: n, path: "/" + parts.slice(0, i + 1).join("/") }))];
});

const data = ref<FsListResponse | null>(null);
const entries = ref<FsEntry[]>([]);
const loading = ref(false);
const error = ref("");
const notice = ref<{ text: string; taskId?: string | null } | null>(null);
const view = ref<"list" | "grid">((localStorage.getItem("hd-files-view") as any) || "list");
watch(view, (v) => localStorage.setItem("hd-files-view", v));
const sortKey = ref<"name" | "size" | "modifiedAt">("name");
const sortDir = ref<1 | -1>(1);
const selected = ref<Set<string>>(new Set());
const lastClicked = ref<number>(-1);
const isAdmin = computed(() => session.me?.kind === "admin");
const canWrite = computed(() => session.me && session.me.kind !== "anon" && !data.value?.mount?.readonly && !!data.value?.mount);

// 密碼
const lock = reactive({ open: false, path: "", password: "", error: "", busy: false });

async function load(more = false) {
  loading.value = true;
  error.value = "";
  try {
    const r = await fs.list(vpath.value, more ? data.value?.cursor ?? undefined : undefined);
    data.value = r;
    entries.value = more ? [...entries.value, ...r.entries] : r.entries;
    if (!more) selected.value = new Set(), thumbFailed.clear();
  } catch (e: any) {
    if (isPasswordError(e)) {
      const m = await fs.meta(vpath.value).catch(() => null);
      Object.assign(lock, { open: true, path: m?.passwordPath ?? vpath.value, password: "", error: "" });
      entries.value = [];
      data.value = null;
    } else if (e instanceof HdApiError && e.status === 401) error.value = t("files.needLogin");
    else error.value = e?.message ?? String(e);
  } finally {
    loading.value = false;
  }
}
watch(vpath, () => {
  preview.entry = null;
  void load();
});

async function unlock() {
  lock.busy = true;
  lock.error = "";
  try {
    await fs.unlock(lock.path, lock.password);
    lock.open = false;
    await load();
  } catch (e: any) {
    lock.error = e?.message ?? String(e);
  } finally {
    lock.busy = false;
  }
}

const sorted = computed(() => {
  const k = sortKey.value;
  const d = sortDir.value;
  return [...entries.value].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    if (k === "name") return d * a.name.localeCompare(b.name, "zh-Hant", { numeric: true });
    const av = (a[k] ?? -1) as number;
    const bv = (b[k] ?? -1) as number;
    return d * (av - bv) || a.name.localeCompare(b.name);
  });
});
function setSort(k: typeof sortKey.value) {
  if (sortKey.value === k) sortDir.value = sortDir.value === 1 ? -1 : 1;
  else (sortKey.value = k), (sortDir.value = 1);
}
const arrow = (k: string) => (sortKey.value === k ? (sortDir.value === 1 ? " ▲" : " ▼") : "");

// ── 選取 ──
function toggle(e: FsEntry, ev?: MouseEvent) {
  const idx = sorted.value.findIndex((x) => x.path === e.path);
  const s = new Set(selected.value);
  if (ev?.shiftKey && lastClicked.value >= 0) {
    const [a, b] = [Math.min(idx, lastClicked.value), Math.max(idx, lastClicked.value)];
    for (const x of sorted.value.slice(a, b + 1)) s.add(x.path);
  } else if (s.has(e.path)) s.delete(e.path);
  else s.add(e.path);
  lastClicked.value = idx;
  selected.value = s;
}
const allSelected = computed(() => sorted.value.length > 0 && sorted.value.every((e) => selected.value.has(e.path)));
function toggleAll() {
  selected.value = allSelected.value ? new Set() : new Set(sorted.value.map((e) => e.path));
}
const selection = computed(() => sorted.value.filter((e) => selected.value.has(e.path)));

// ── 開啟／預覽 ──
const preview = reactive<{ entry: FsEntry | null }>({ entry: null });
const previewComp = shallowRef<any>(null);
function open(e: FsEntry) {
  if (e.isDir) return router.push(toRoute(e.path));
  preview.entry = e;
  previewComp.value = previewComponent(previewKind(e.name, e.mime), e.name);
}
const previewInfo = computed(() =>
  preview.entry ? { slug: "", filename: preview.entry.name, size: preview.entry.size ?? 0, mime: preview.entry.mime, sha256: null } : null,
);

// ── 操作選單 ──
const menu = reactive({ open: false, x: 0, y: 0 });
function openMenu(ev: MouseEvent, e?: FsEntry) {
  if (e && !selected.value.has(e.path)) selected.value = new Set([e.path]);
  Object.assign(menu, { open: true, x: Math.min(ev.clientX, window.innerWidth - 200), y: Math.min(ev.clientY, window.innerHeight - 280) });
}
const closeMenu = () => (menu.open = false);

async function act(fn: () => Promise<unknown>) {
  closeMenu();
  error.value = "";
  try {
    await fn();
  } catch (e: any) {
    if (isPasswordError(e)) await load();
    else error.value = e?.message ?? String(e);
  }
}
const doMkdir = () =>
  act(async () => {
    const n = prompt(t("files.mkdirPrompt"))?.trim();
    if (!n) return;
    await fs.mkdir((vpath.value === "/" ? "" : vpath.value) + "/" + n);
    await load();
  });
const doRename = () =>
  act(async () => {
    const e = selection.value[0];
    if (!e) return;
    const n = prompt(t("files.renamePrompt"), e.name)?.trim();
    if (!n || n === e.name) return;
    await fs.rename(e.path, n);
    await load();
  });
const doDelete = () =>
  act(async () => {
    const paths = selection.value.map((e) => e.path);
    if (!paths.length || !confirm(t("files.confirmDelete", { n: paths.length }))) return;
    await fs.remove(paths);
    await load();
  });
const doTransfer = (move: boolean) =>
  act(async () => {
    const paths = selection.value.map((e) => e.path);
    if (!paths.length) return;
    const dst = prompt(t("files.dstPrompt"), vpath.value)?.trim();
    if (!dst) return;
    const r = await (move ? fs.move(paths, dst) : fs.copy(paths, dst));
    if (r.taskId) notice.value = { text: t("files.queued", { n: r.queued }) + (r.done ? `（${t("files.doneDirect", { n: r.done })}）` : ""), taskId: r.taskId };
    else notice.value = { text: t("files.doneDirect", { n: r.done }) };
    await load();
  });
const doShare = () =>
  act(async () => {
    const e = selection.value[0];
    if (!e || e.isDir) return;
    const r = await fs.share(e.path, {});
    notice.value = { text: t("files.shareCreated", { url: r.url }) };
    await navigator.clipboard?.writeText(r.url).catch(() => {});
  });
function doDownload() {
  closeMenu();
  for (const e of selection.value.filter((x) => !x.isDir)) {
    const a = document.createElement("a");
    a.href = downloadUrl(e.path);
    a.download = e.name;
    a.click();
  }
}

// ── 上傳 ──
const over = ref(false);
let dragDepth = 0;
const fileInput = ref<HTMLInputElement | null>(null);
const folderInput = ref<HTMLInputElement | null>(null);
function onDragEnter(e: DragEvent) {
  if (!e.dataTransfer?.types.includes("Files")) return;
  dragDepth++;
  over.value = true;
}
function onDragLeave() {
  if (--dragDepth <= 0) (dragDepth = 0), (over.value = false);
}
async function onDrop(e: DragEvent) {
  dragDepth = 0;
  over.value = false;
  if (!canWrite.value || !e.dataTransfer) return;
  const items = await filesFromDataTransfer(e.dataTransfer);
  if (items.length) enqueueDropped(vpath.value, items);
}
function onPick(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  if (files.length) enqueue(vpath.value, files);
  input.value = "";
}
function onPickFolder(e: Event) {
  const input = e.target as HTMLInputElement;
  const items = collectFolderFiles(input.files ?? []);
  if (items.length) enqueueFolder(vpath.value, items);
  input.value = "";
}
const qVisible = computed(() => queue.items.length > 0);
const failedCount = computed(() => queue.items.filter((i) => i.status === "error").length);
const pct = (f?: number) => `${Math.round((f ?? 0) * 100)}%`;

let off: (() => void) | undefined;
onMounted(() => {
  void load();
  off = onUploaded((dir) => dir === vpath.value && load());
  window.addEventListener("click", closeMenu);
});
onBeforeUnmount(() => {
  off?.();
  window.removeEventListener("click", closeMenu);
});

const icon = (e: FsEntry) => (e.isDir ? (e.mount ? "🗄️" : "📁") : ({ image: "🖼️", video: "🎬", audio: "🎵", pdf: "📕", markdown: "📝", text: "📄", office: "📊", epub: "📚" } as Record<string, string>)[previewKind(e.name, e.mime)] ?? "📄");

// ── 縮略圖 ──
// 圖片直接用 inline 下載連結當縮略圖（瀏覽器跟隨 302 到儲存直連；載入失敗時退回圖標）
const thumbFailed = reactive(new Set<string>());
const isImage = (e: FsEntry) => !e.isDir && previewKind(e.name, e.mime) === "image";
const showThumb = (e: FsEntry) => isImage(e) && !thumbFailed.has(e.path);
const thumbSrc = (e: FsEntry) => downloadUrl(e.path, true);
</script>

<template>
  <div class="card files" @dragenter.prevent="onDragEnter" @dragover.prevent @dragleave="onDragLeave" @drop.prevent="onDrop" @contextmenu.prevent="openMenu($event)">
    <nav class="crumbs">
      <template v-for="(c, i) in crumbs" :key="c.path">
        <span v-if="i" class="muted"> / </span>
        <RouterLink :to="toRoute(c.path)">{{ c.name }}</RouterLink>
      </template>
      <span v-if="data?.mount?.readonly" class="tag">{{ t("files.readonly") }}</span>
    </nav>

    <div class="row toolbar">
      <button v-if="canWrite" @click="fileInput?.click()">{{ t("files.upload") }}</button>
      <input ref="fileInput" type="file" multiple hidden @change="onPick" />
      <button v-if="canWrite" class="ghost" @click="folderInput?.click()">{{ t("files.uploadFolder") }}</button>
      <input ref="folderInput" type="file" webkitdirectory hidden @change="onPickFolder" />
      <button v-if="canWrite" class="ghost" @click="doMkdir">{{ t("files.mkdir") }}</button>
      <span v-if="selection.length" class="muted">{{ t("files.selected", { n: selection.length }) }}</span>
      <button v-if="selection.length" class="ghost" @click.stop="openMenu($event)">{{ t("files.actions") }} ▾</button>
      <span class="grow" />
      <select v-model="sortKey" style="width: auto" :title="t('files.sortBy')">
        <option value="name">{{ t("files.name") }}</option>
        <option value="size">{{ t("files.size") }}</option>
        <option value="modifiedAt">{{ t("files.modified") }}</option>
      </select>
      <button class="ghost" @click="sortDir = sortDir === 1 ? -1 : 1">{{ sortDir === 1 ? t("files.asc") : t("files.desc") }}</button>
      <button class="ghost" @click="view = view === 'list' ? 'grid' : 'list'">{{ view === "list" ? t("files.gridView") : t("files.listView") }}</button>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="notice">
      {{ notice.text }}
      <RouterLink v-if="notice.taskId && isAdmin" to="/admin/tasks">{{ t("files.viewTask") }}</RouterLink>
      <a href="#" @click.prevent="notice = null">✕</a>
    </p>

    <div v-if="data?.headerMd" class="md"><component :is="MarkdownPreview" :text="data.headerMd" src="" :info="{ size: 0 }" /></div>

    <p v-if="loading && !entries.length" class="muted">{{ t("files.loading") }}</p>
    <p v-else-if="!loading && data && !entries.length" class="muted">{{ t("files.empty") }}</p>

    <table v-if="view === 'list' && entries.length">
      <thead>
        <tr>
          <th style="width: 28px"><input type="checkbox" :checked="allSelected" @change="toggleAll" /></th>
          <th class="sort" @click="setSort('name')">{{ t("files.name") }}{{ arrow("name") }}</th>
          <th class="sort" style="width: 110px" @click="setSort('size')">{{ t("files.size") }}{{ arrow("size") }}</th>
          <th class="sort" style="width: 170px" @click="setSort('modifiedAt')">{{ t("files.modified") }}{{ arrow("modifiedAt") }}</th>
          <th style="width: 40px"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="e in sorted" :key="e.path" :class="{ sel: selected.has(e.path), dim: e.hidden }" @contextmenu.prevent.stop="openMenu($event, e)">
          <td><input type="checkbox" :checked="selected.has(e.path)" @click.stop="toggle(e, $event)" /></td>
          <td>
            <a href="#" @click.prevent="open(e)"><img v-if="showThumb(e)" class="thumb" :src="thumbSrc(e)" loading="lazy" alt="" @error="thumbFailed.add(e.path)" /><template v-else>{{ icon(e) }} </template>{{ e.name }}</a>
            <span v-if="e.mount" class="tag">{{ t("files.mount") }}</span>
            <span v-if="e.hidden" class="tag">{{ t("files.hidden") }}</span>
          </td>
          <td>{{ e.isDir ? "-" : formatBytes(e.size ?? NaN) }}</td>
          <td>{{ formatTime(e.modifiedAt) }}</td>
          <td><button class="ghost mini" @click.stop="openMenu($event, e)">⋯</button></td>
        </tr>
      </tbody>
    </table>

    <div v-else-if="view === 'grid' && entries.length" class="grid">
      <div v-for="e in sorted" :key="e.path" class="tile" :class="{ sel: selected.has(e.path), dim: e.hidden }" @click="toggle(e, $event)" @dblclick="open(e)" @contextmenu.prevent.stop="openMenu($event, e)">
        <button class="ghost mini tile-menu" @click.stop="openMenu($event, e)">⋯</button>
        <div class="ico"><img v-if="showThumb(e)" class="thumb-lg" :src="thumbSrc(e)" loading="lazy" alt="" @error="thumbFailed.add(e.path)" /><template v-else>{{ icon(e) }}</template></div>
        <a href="#" class="nm" @click.prevent.stop="open(e)">{{ e.name }}</a>
        <div class="muted">{{ e.isDir ? "" : formatBytes(e.size ?? NaN) }}</div>
      </div>
    </div>

    <p v-if="data?.cursor"><button class="ghost" :disabled="loading" @click="load(true)">{{ t("files.loadMore") }}</button></p>

    <div v-if="data?.readmeMd" class="md"><component :is="MarkdownPreview" :text="data.readmeMd" src="" :info="{ size: 0 }" /></div>

    <div v-if="over && canWrite" class="dropmask">{{ t("files.dropHere") }}</div>
  </div>

  <!-- 操作選單 -->
  <div v-if="menu.open" class="ctxmenu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }" @click.stop>
    <template v-if="selection.length === 1">
      <a href="#" @click.prevent="(closeMenu(), open(selection[0]))">{{ selection[0].isDir ? t("files.open") : t("files.preview") }}</a>
    </template>
    <a v-if="selection.some((e) => !e.isDir)" href="#" @click.prevent="doDownload">{{ t("files.download") }}</a>
    <template v-if="canWrite">
      <a v-if="selection.length === 1" href="#" @click.prevent="doRename">{{ t("files.rename") }}</a>
      <a v-if="selection.length" href="#" @click.prevent="doTransfer(false)">{{ t("files.copy") }}</a>
      <a v-if="selection.length" href="#" @click.prevent="doTransfer(true)">{{ t("files.move") }}</a>
      <a v-if="selection.length" href="#" class="error" @click.prevent="doDelete">{{ t("files.delete") }}</a>
      <a href="#" @click.prevent="doMkdir">{{ t("files.mkdir") }}</a>
      <a href="#" @click.prevent="(closeMenu(), fileInput?.click())">{{ t("files.upload") }}</a>
    </template>
    <a v-if="session.me && session.me.kind !== 'anon' && selection.length === 1 && !selection[0].isDir" href="#" @click.prevent="doShare">{{ t("files.share") }}</a>
    <a v-if="selection.length" href="#" @click.prevent="(closeMenu(), (selected = new Set()))">{{ t("files.clearSel") }}</a>
  </div>

  <!-- 密碼 -->
  <div v-if="lock.open" class="modal">
    <form class="card dialog" @submit.prevent="unlock">
      <h3>🔒 {{ t("files.locked") }}</h3>
      <p class="muted">{{ lock.path }}</p>
      <label>{{ t("files.password") }}</label>
      <input v-model="lock.password" type="password" autofocus />
      <p v-if="lock.error" class="error">{{ lock.error }}</p>
      <div class="row" style="margin-top: 12px">
        <button type="submit" :disabled="lock.busy">{{ t("files.unlock") }}</button>
        <button type="button" class="ghost" @click="(lock.open = false, router.push(toRoute(crumbs.length > 1 ? crumbs[crumbs.length - 2].path : '/')))">{{ t("files.cancel") }}</button>
      </div>
    </form>
  </div>

  <!-- 預覽 -->
  <div v-if="preview.entry" class="modal" @click.self="preview.entry = null">
    <div class="card dialog wide">
      <div class="row">
        <strong class="grow">{{ preview.entry.name }}</strong>
        <a :href="downloadUrl(preview.entry.path)" :download="preview.entry.name">{{ t("files.download") }}</a>
        <button class="ghost" @click="preview.entry = null">{{ t("files.close") }}</button>
      </div>
      <div class="preview" style="margin-top: 12px">
        <component :is="previewComp" v-if="previewComp" :key="preview.entry.path" :src="downloadUrl(preview.entry.path, true)" :info="previewInfo" />
        <p v-else class="muted">{{ t("files.noPreview") }}</p>
      </div>
    </div>
  </div>

  <!-- 上傳佇列 -->
  <div v-if="qVisible" class="card queue">
    <div class="row">
      <strong class="grow">{{ t("files.queue") }}</strong>
      <button v-if="failedCount" class="ghost mini" @click="retryAllFailed">{{ t("files.retryAll", { n: failedCount }) }}</button>
      <button class="ghost mini" @click="clearFinished">{{ t("files.clearDone") }}</button>
    </div>
    <div v-for="it in queue.items" :key="it.id" class="qitem">
      <div class="row">
        <span class="grow nm" :title="it.label ?? it.relativePath ?? it.file.name">{{ it.label ?? it.relativePath ?? it.file.name }}</span>
        <span class="muted">{{ t(`files.status.${it.status}`) }}</span>
        <span v-if="it.status === 'running' && it.speed" class="muted">{{ t("files.speed", { v: formatBytes(it.speed) }) }}</span>
        <button v-if="it.status === 'error' || it.status === 'canceled'" class="ghost mini" @click="retryItem(it)">{{ t("files.retry") }}</button>
        <button v-if="it.status === 'running' || it.status === 'waiting'" class="ghost mini" @click="cancelItem(it)">{{ t("files.cancel") }}</button>
      </div>
      <div class="progress"><div :style="{ width: it.status === 'done' ? '100%' : pct(it.progress?.fraction) }" /></div>
      <div class="muted">
        {{ formatBytes(it.file.size) }} → {{ it.dir }}
        <span v-if="it.retryMsg && it.status === 'running'"> · {{ it.retryMsg }}</span>
        <span v-if="it.error" class="error"> · {{ it.error }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.files { position: relative; min-height: 300px; }
.crumbs { margin-bottom: 12px; font-size: 15px; }
.toolbar { margin-bottom: 12px; }
.tag { font-size: 12px; background: var(--line); border-radius: 4px; padding: 1px 6px; margin-left: 6px; }
th.sort { cursor: pointer; user-select: none; }
tr.sel, .tile.sel { background: #f0fdfa; }
.dim { opacity: 0.55; }
button.mini { padding: 2px 8px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; }
.tile { position: relative; border: 1px solid var(--line); border-radius: 10px; padding: 10px; text-align: center; cursor: pointer; user-select: none; }
.tile .tile-menu { position: absolute; top: 4px; right: 4px; padding: 2px 8px; }
.tile .ico { font-size: 36px; }
.thumb { width: 40px; height: 40px; object-fit: cover; border-radius: 6px; vertical-align: middle; margin-right: 6px; }
.tile .thumb-lg { width: 100%; height: 96px; object-fit: cover; border-radius: 8px; display: block; }
.tile .nm, .qitem .nm { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dropmask { position: absolute; inset: 0; background: rgba(240, 253, 250, 0.9); border: 2px dashed var(--c); border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 18px; pointer-events: none; }
.ctxmenu { position: fixed; z-index: 50; background: #fff; border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.12); min-width: 170px; padding: 4px 0; }
.ctxmenu a { display: block; padding: 7px 14px; text-decoration: none; }
.ctxmenu a:hover { background: #f1f5f9; }
.modal { position: fixed; inset: 0; z-index: 40; background: rgba(15, 23, 42, 0.45); display: flex; align-items: center; justify-content: center; padding: 16px; }
.dialog { width: 360px; max-width: 100%; margin: 0; }
.dialog.wide { width: 960px; max-height: 92vh; overflow: auto; }
.queue { position: fixed; right: 16px; bottom: 16px; width: 360px; max-height: 50vh; overflow: auto; z-index: 30; margin: 0; padding: 12px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.12); }
.qitem { margin-top: 10px; }
.notice { background: #f0fdfa; border-radius: 8px; padding: 8px 12px; }
.md { margin: 12px 0; }
</style>
