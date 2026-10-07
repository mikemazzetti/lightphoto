import { api, basename, FILTERS, stem } from '@/platform/api';
import { errorToast, toast } from '@/state/app';
import { confirmDialog } from '@/ui/overlays';
import { defaultProject, normalizeProject } from '../model/defaults';
import { checkMissing } from '../engine/media';
import { flushAutosave, getState, replaceProject, useVideo } from './store';
import { transport } from './transport';
import { timelineApi } from '../timeline/api';

const isDirty = () => {
  const s = getState();
  return s.project !== s.savedProject && (s.project.media.length > 0 || s.project.seq.clips.length > 0);
};

async function confirmDiscard(): Promise<boolean> {
  if (!isDirty()) return true;
  return confirmDialog('The current video project has unsaved changes. Discard them?', { title: 'Unsaved Changes', ok: 'Discard', danger: true });
}

export async function newProject() {
  if (!(await confirmDiscard())) return;
  transport.pause();
  const p = defaultProject();
  replaceProject(p, { resetHistory: true, label: 'New Project', saved: true, filePath: null });
  useVideo.setState({ sourceId: null, scrollX: 0, scrollY: 0 });
  transport.seek(0);
  flushAutosave();
}

export async function openProjectPath(path: string) {
  try {
    const buf = await api.readFile(path);
    const json = JSON.parse(new TextDecoder().decode(buf));
    // Wrapped ({ app, version, project }) or a bare project; either way it needs a sequence object.
    const raw = json?.app === 'lightphoto-video' ? json.project : json;
    if (!raw || typeof raw !== 'object' || !raw.seq || typeof raw.seq !== 'object') throw new Error('Not a LightPhoto video project.');
    if (Number(json.version ?? 1) > 1 || Number(raw.version ?? 1) > 1) throw new Error('This project was saved by a newer version of LightPhoto Studio.');
    const p = normalizeProject(raw);
    if (!p.name || p.name === 'Untitled Project') p.name = stem(path);
    transport.pause();
    replaceProject(p, { resetHistory: true, label: 'Open Project', saved: true, filePath: path });
    useVideo.setState({ sourceId: null, scrollX: 0, scrollY: 0 });
    transport.seek(0);
    setTimeout(() => timelineApi.fit?.(), 0);
    await checkMissing();
    toast(`Opened ${basename(path)}`, 'success', 1800);
  } catch (e) {
    errorToast(e, 'Open failed');
  }
}

export async function openProject() {
  if (!(await confirmDiscard())) return;
  const paths = await api.openFiles({ title: 'Open Video Project', filters: [FILTERS.videoProject], multi: false });
  if (paths[0]) await openProjectPath(paths[0]);
}

export async function saveProject(saveAs = false): Promise<boolean> {
  const s = getState();
  let path = saveAs ? null : s.filePath;
  if (path && !path.toLowerCase().endsWith('.lpv')) path = null;
  if (!path) {
    path = await api.saveDialog({ title: 'Save Video Project', defaultPath: `${s.project.name || 'Untitled'}.lpv`, filters: [FILTERS.videoProject] });
    if (!path) return false;
  }
  try {
    let project = getState().project;
    if (saveAs || project.name === 'Untitled Project') {
      project = { ...project, name: stem(path) };
      replaceProject(project);
    }
    const json = JSON.stringify({ app: 'lightphoto-video', version: 1, savedAt: new Date().toISOString(), project }, null, 1);
    await api.writeFile(path, json);
    useVideo.setState({ savedProject: project, filePath: path });
    flushAutosave();
    toast(`Saved ${basename(path)}`, 'success', 1600);
    return true;
  } catch (e) {
    errorToast(e, 'Save failed');
    return false;
  }
}
