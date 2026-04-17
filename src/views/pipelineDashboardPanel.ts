import * as vscode from 'vscode';
import { AzureDevOpsApi } from '../api/azureDevOpsApi';

export class PipelineDashboardPanel {
  static currentPanel: PipelineDashboardPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _project: string;
  private _repoId: string;
  private _repoName: string;
  private _extensionUri: vscode.Uri;

  // postMessage handshake state
  private _webviewReady = false;
  private _pendingMessages: any[] = [];

  /** Queue-safe postMessage: buffers if webview isn't ready yet */
  private _post(msg: any) {
    if (this._webviewReady) {
      this._panel.webview.postMessage(msg);
    } else {
      this._pendingMessages.push(msg);
    }
  }

  private _flushPending() {
    this._webviewReady = true;
    for (const msg of this._pendingMessages) {
      this._panel.webview.postMessage(msg);
    }
    this._pendingMessages = [];
  }

  static createOrShow(extensionUri: vscode.Uri, api: AzureDevOpsApi, project?: string, repoId?: string, repoName?: string) {
    const column = vscode.ViewColumn.One;
    const resolvedProject = project || vscode.workspace.getConfiguration('azureDevOpsPR').get<string>('project', '');

    if (PipelineDashboardPanel.currentPanel) {
      const p = PipelineDashboardPanel.currentPanel;
      p._panel.reveal(column);
      const changed = p._project !== resolvedProject || p._repoId !== (repoId || '');
      p._project = resolvedProject;
      p._repoId = repoId || '';
      p._repoName = repoName || '';
      if (changed) {
        p._sendPipelines();
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'azureDevOpsPipelineDashboard',
      'Pipeline Dashboard',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );

    PipelineDashboardPanel.currentPanel = new PipelineDashboardPanel(panel, extensionUri, api, resolvedProject, repoId || '', repoName || '');
  }

  static createOrShowForBuild(extensionUri: vscode.Uri, api: AzureDevOpsApi, build: { id: number; buildNumber: string; definitionName: string; project?: string }, repoId?: string, repoName?: string) {
    PipelineDashboardPanel.createOrShow(extensionUri, api, build.project, repoId, repoName);
    const panel = PipelineDashboardPanel.currentPanel;
    if (!panel) { return; }
    panel._sendBuild(build);
  }

  private async _sendBuild(build: { id: number; buildNumber: string; definitionName: string; project?: string }) {
    this._panel.title = `${build.definitionName} - Pipeline Dashboard`;
    this._post({
      command: 'navigateToBuild',
      buildId: build.id,
      buildNumber: build.buildNumber,
      definitionName: build.definitionName,
      project: build.project,
    });
    // Also fetch and send timeline
    const project = build.project || this._project;
    try {
      const timeline = await this.api.getBuildTimeline(build.id, project);
      if (timeline?.records?.length) {
        const sample = timeline.records[0];
        console.log('[Pipeline Dashboard] Timeline record sample - type:', sample.type, 'state:', sample.state, '(' + typeof sample.state + ')', 'result:', sample.result, '(' + typeof sample.result + ')');
        console.log('[Pipeline Dashboard] Record types:', [...new Set(timeline.records.map((r: any) => r.type))].join(', '));
        console.log('[Pipeline Dashboard] Total records:', timeline.records.length);
      }
      const stages = timeline?.records ? this._buildTimelineHierarchy(timeline.records) : [];
      console.log('[Pipeline Dashboard] Built hierarchy:', stages.length, 'stages, jobs per stage:', stages.map((s: any) => s.name + ':' + s.jobs.length).join(', '));
      this._post({ command: 'timelineLoaded', buildId: build.id, stages });
    } catch (err: any) {
      this._post({ command: 'error', message: `Failed to load timeline: ${err?.message ?? err}` });
    }
  }

  private async _sendPipelines() {
    if (!this._project) {
      this._post({ command: 'pipelinesLoaded', pipelines: [], project: this._project });
      return;
    }
    try {
      const repo = this._repoId || undefined;
      console.log('[Pipeline Dashboard] Loading pipelines for project:', this._project, 'repo:', repo || '(all)');
      const definitions = await this.api.getPipelineDefinitions(this._project, repo);
      console.log('[Pipeline Dashboard] Got', definitions?.length ?? 0, 'definitions');
      const pipelines = (definitions || []).map((d: any) => ({
        id: d.id,
        name: d.name,
        path: d.path,
        queueStatus: d.queueStatus,
        latestBuild: d.latestBuild ? {
          id: d.latestBuild.id,
          buildNumber: d.latestBuild.buildNumber,
          status: d.latestBuild.status,
          result: d.latestBuild.result,
          finishTime: d.latestBuild.finishTime,
          sourceBranch: d.latestBuild.sourceBranch,
          url: this._buildRunUrl(this._project, d.latestBuild.id),
        } : null,
        url: d._links?.web?.href,
      }));
      console.log('[Pipeline Dashboard] Sending pipelinesLoaded with', pipelines.length, 'pipelines');
      this._post({ command: 'pipelinesLoaded', pipelines, project: this._project });
    } catch (err: any) {
      console.error('[Pipeline Dashboard] _sendPipelines error:', err);
      this._post({ command: 'error', message: `Failed to load pipelines: ${err?.message ?? err}` });
    }
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private api: AzureDevOpsApi,
    project: string,
    repoId: string,
    repoName: string
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._project = project;
    this._repoId = repoId;
    this._repoName = repoName;

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (msg) => {
        try {
          switch (msg.command) {
            case 'ready':
              console.log('[Pipeline Dashboard] Received ready from webview');
              this._flushPending();
              console.log('[Pipeline Dashboard] Calling _sendPipelines, project:', this._project, 'repoId:', this._repoId);
              await this._sendPipelines();
              console.log('[Pipeline Dashboard] _sendPipelines completed');
              break;
            case 'loadPipelines':
              await this._handleLoadPipelines(msg.project, msg.repoId);
              break;
            case 'loadBuilds':
              await this._handleLoadBuilds(msg.definitionId, msg.project);
              break;
            case 'loadTimeline':
              await this._handleLoadTimeline(msg.buildId, msg.project);
              break;
            case 'queueBuild':
              await this._handleQueueBuild(msg.definitionId, msg.branch, msg.project);
              break;
            case 'openInBrowser':
              if (msg.url) {
                vscode.env.openExternal(vscode.Uri.parse(msg.url));
              }
              break;
          }
        } catch (err: any) {
          const message = `Dashboard error: ${err?.message ?? err}`;
          console.error('[Pipeline Dashboard]', message, err);
          this._post({ command: 'error', message });
        }
      },
      null,
      this._disposables
    );

    // Set STATIC HTML — NO interpolated data, all data flows via postMessage
    this._panel.webview.html = this._getHtml();
  }

  private async _handleLoadPipelines(project: string, repoId?: string) {
    const repo = repoId || this._repoId || undefined;
    const definitions = await this.api.getPipelineDefinitions(project, repo);
    if (!Array.isArray(definitions)) {
      throw new Error('Unexpected API response');
    }
    const pipelines = definitions.map((d: any) => ({
      id: d.id,
      name: d.name,
      path: d.path,
      queueStatus: d.queueStatus,
      latestBuild: d.latestBuild ? {
        id: d.latestBuild.id,
        buildNumber: d.latestBuild.buildNumber,
        status: d.latestBuild.status,
        result: d.latestBuild.result,
        finishTime: d.latestBuild.finishTime,
        sourceBranch: d.latestBuild.sourceBranch,
        url: this._buildRunUrl(project, d.latestBuild.id),
      } : null,
      url: d._links?.web?.href,
    }));
    this._post({ command: 'pipelinesLoaded', pipelines, project });
  }

  private async _handleLoadBuilds(definitionId: number, project: string) {
    const builds = await this.api.getBuildsForDefinition(definitionId, project, 10);
    const mapped = builds.map((b: any) => ({
      id: b.id,
      buildNumber: b.buildNumber,
      status: b.status,
      result: b.result,
      sourceBranch: b.sourceBranch?.replace('refs/heads/', ''),
      requestedFor: b.requestedFor?.displayName,
      startTime: b.startTime,
      finishTime: b.finishTime,
      url: this._buildRunUrl(project, b.id) || b._links?.web?.href,
    }));
    this._post({ command: 'buildsLoaded', definitionId, builds: mapped });
  }

  private _buildRunUrl(project: string | undefined, buildId: number | undefined): string | undefined {
    const orgUrl = vscode.workspace.getConfiguration('azureDevOpsPR').get<string>('organizationUrl', '').trim().replace(/\/$/, '');
    if (!orgUrl || !project || !buildId) {
      return undefined;
    }
    return `${orgUrl}/${encodeURIComponent(project)}/_build/results?buildId=${buildId}&view=results`;
  }

  private async _handleLoadTimeline(buildId: number, project: string) {
    const timeline = await this.api.getBuildTimeline(buildId, project);
    if (timeline?.records?.length) {
      const types = [...new Set(timeline.records.map((r: any) => r.type))];
      console.log('[Pipeline Dashboard] _handleLoadTimeline records:', timeline.records.length, 'types:', types.join(', '));
      // Log a few records for debugging
      timeline.records.slice(0, 5).forEach((r: any) => {
        console.log('[Pipeline Dashboard]   record:', r.type, r.name, 'state:', r.state, 'result:', r.result, 'parentId:', r.parentId, 'id:', r.id);
      });
    }
    const stages = timeline?.records ? this._buildTimelineHierarchy(timeline.records) : [];
    console.log('[Pipeline Dashboard] Hierarchy: stages:', stages.length, stages.map((s: any) => s.name + '(' + s.jobs.length + ' jobs)').join(', '));
    this._post({ command: 'timelineLoaded', buildId, stages });
  }

  private async _handleQueueBuild(definitionId: number, branch: string, project: string) {
    const build = await this.api.queueBuild(definitionId, branch || undefined, project);
    vscode.window.showInformationMessage(`Pipeline run #${build.buildNumber} queued!`);
    this._post({
      command: 'buildQueued',
      build: {
        id: build.id,
        buildNumber: build.buildNumber,
        status: build.status,
        url: build._links?.web?.href,
      },
    });
  }

  private _buildTimelineHierarchy(records: any[]): any[] {
    // Azure DevOps uses "Phase" for YAML jobs and "Job" for classic — handle both
    const isJob = (r: any) => r.type === 'Job' || r.type === 'Phase';
    return records
      .filter((r: any) => r.type === 'Stage')
      .sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0))
      .map((stage: any) => ({
        name: stage.name,
        state: stage.state,
        result: stage.result,
        startTime: stage.startTime,
        finishTime: stage.finishTime,
        jobs: records
          .filter((r: any) => isJob(r) && r.parentId === stage.id)
          .sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0))
          .map((job: any) => ({
            name: job.name,
            state: job.state,
            result: job.result,
            startTime: job.startTime,
            finishTime: job.finishTime,
            tasks: records
              .filter((r: any) => r.type === 'Task' && r.parentId === job.id)
              .sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0))
              .map((task: any) => ({
                name: task.name,
                state: task.state,
                result: task.result,
                startTime: task.startTime,
                finishTime: task.finishTime,
                log: task.log?.url,
                issues: task.issues?.map((i: any) => ({ type: i.type, message: i.message })),
              })),
          })),
      }));
  }

  private _getHtml(): string {
    const webview = this._panel.webview;
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'pipelineDashboard.js'));
    const orgUrl = vscode.workspace.getConfiguration('azureDevOpsPR').get<string>('organizationUrl', '').replace(/\/$/, '');
    const pipelinesUrl = orgUrl && this._project ? `${orgUrl}/${encodeURIComponent(this._project)}/_build` : '';
    const projectLabel = this._project ? this._escapeHtml(this._project) : 'No project selected';
    const repoLabel = this._repoName ? ` / ${this._escapeHtml(this._repoName)}` : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' ${webview.cspSource};">
  <style>
    :root { --radius: 4px; }
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 0; margin: 0; }
    .header { padding: 16px 24px; background: var(--vscode-editor-inactiveSelectionBackground); border-bottom: 1px solid var(--vscode-panel-border); display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .header h1 { font-size: 1.3em; margin: 0; white-space: nowrap; }
    .header-controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; flex: 1; }
    select, input { padding: 5px 10px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: var(--radius); font-family: inherit; font-size: inherit; }
    .content { padding: 16px 24px; }
    button { padding: 6px 14px; border: 1px solid var(--vscode-button-border, transparent); border-radius: var(--radius); cursor: pointer; font-size: 0.9em; font-family: inherit; }
    .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
    .btn-sm { padding: 3px 10px; font-size: 0.85em; }
    .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .btn-icon { background: transparent; border: none; color: var(--vscode-foreground); cursor: pointer; padding: 4px 6px; font-size: 1em; border-radius: var(--radius); }
    .btn-icon:hover { background: var(--vscode-toolbar-hoverBackground); }
    .pipeline-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 12px; }
    .pipeline-card { background: var(--vscode-editor-inactiveSelectionBackground); border: 1px solid var(--vscode-panel-border); border-radius: 6px; overflow: hidden; }
    .pipeline-card-header { padding: 12px 16px; display: flex; align-items: center; justify-content: space-between; gap: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
    .pipeline-name { font-weight: 600; font-size: 1em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
    .pipeline-path { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
    .pipeline-card-body { padding: 12px 16px; }
    .pipeline-card-actions { padding: 8px 16px; border-top: 1px solid var(--vscode-panel-border); display: flex; gap: 6px; }
    .build-badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 10px; font-size: 0.82em; font-weight: 500; }
    .build-badge.succeeded { background: rgba(40,167,69,0.15); color: #28a745; }
    .build-badge.failed { background: rgba(220,53,69,0.15); color: #dc3545; }
    .build-badge.inprogress { background: rgba(0,120,212,0.15); color: #0078d4; }
    .build-badge.canceled { background: rgba(108,117,125,0.15); color: #6c757d; }
    .build-badge.partial { background: rgba(255,193,7,0.15); color: #e6a800; }
    .build-badge.none { background: rgba(108,117,125,0.1); color: var(--vscode-descriptionForeground); }
    .build-info { font-size: 0.85em; color: var(--vscode-descriptionForeground); margin-top: 6px; }
    .builds-table { width: 100%; border-collapse: collapse; font-size: 0.9em; margin-top: 8px; }
    .builds-table th { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); font-weight: 500; }
    .builds-table td { padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
    .builds-table tr:hover { background: var(--vscode-list-hoverBackground); }
    .builds-table tr { cursor: pointer; }
    .link { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
    .link:hover { text-decoration: underline; }
    .timeline-panel { margin-top: 16px; }
    .stage { margin-bottom: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; overflow: hidden; }
    .stage-header { padding: 10px 14px; display: flex; align-items: center; gap: 8px; background: var(--vscode-editor-inactiveSelectionBackground); cursor: pointer; user-select: none; }
    .stage-header:hover { background: var(--vscode-list-hoverBackground); }
    .stage-name { font-weight: 600; flex: 1; }
    .stage-duration { font-size: 0.85em; color: var(--vscode-descriptionForeground); }
    .job { margin-left: 20px; border-left: 2px solid var(--vscode-panel-border); }
    .job-header { padding: 8px 12px; display: flex; align-items: center; gap: 8px; cursor: pointer; }
    .job-header:hover { background: var(--vscode-list-hoverBackground); }
    .job-name { font-weight: 500; flex: 1; }
    .task { margin-left: 20px; padding: 4px 12px; display: flex; align-items: center; gap: 8px; font-size: 0.9em; border-left: 2px solid var(--vscode-panel-border); }
    .task:hover { background: var(--vscode-list-hoverBackground); }
    .task-name { flex: 1; }
    .task-issue { font-size: 0.85em; color: var(--vscode-errorForeground); margin-left: 32px; padding: 2px 0; }
    .status-icon { width: 16px; text-align: center; flex-shrink: 0; }
    .chevron { transition: transform 0.15s; }
    .chevron.collapsed { transform: rotate(-90deg); }
    .collapsible-content { display: block; }
    .collapsible-content.hidden { display: none; }
    .progress-bar-container { flex: 1; max-width: 200px; height: 6px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 3px; overflow: hidden; margin: 0 8px; }
    .progress-bar { height: 100%; border-radius: 3px; transition: width 0.5s ease; }
    .progress-bar.succeeded { background: #28a745; }
    .progress-bar.failed { background: #dc3545; }
    .progress-bar.inprogress { background: #0078d4; animation: pulse 1.5s ease-in-out infinite; }
    .progress-bar.partial { background: #e6a800; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.6; } }
    .progress-pct { font-size: 0.8em; color: var(--vscode-descriptionForeground); min-width: 36px; text-align: right; }
    .stage-progress { display: flex; align-items: center; gap: 4px; margin-top: 4px; padding: 0 14px 8px; }
    .overall-progress { display: flex; align-items: center; gap: 8px; padding: 8px 0; margin-bottom: 8px; }
    .overall-progress .progress-bar-container { max-width: 100%; flex: 1; height: 8px; }
    .overall-progress-label { font-size: 0.85em; font-weight: 500; white-space: nowrap; }
    .auto-refresh-note { font-size: 0.8em; color: var(--vscode-descriptionForeground); font-style: italic; }
    .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.45); z-index: 100; justify-content: center; align-items: center; }
    .modal-overlay.visible { display: flex; }
    .modal { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 24px; min-width: 380px; max-width: 500px; box-shadow: 0 8px 32px rgba(0,0,0,0.3); }
    .modal h2 { margin: 0 0 16px; font-size: 1.1em; }
    .field { margin-bottom: 14px; }
    .field label { display: block; margin-bottom: 4px; font-weight: 500; }
    .field input { width: 100%; box-sizing: border-box; }
    .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
    .error-banner { background: rgba(220,53,69,0.12); color: var(--vscode-errorForeground); padding: 12px 16px; border-radius: var(--radius); margin-bottom: 12px; display: none; border: 1px solid rgba(220,53,69,0.3); }
    .error-banner.visible { display: flex; align-items: center; gap: 8px; }
    .error-banner .dismiss-btn { margin-left: auto; cursor: pointer; opacity: 0.7; background: none; border: none; color: inherit; font-size: 1.1em; padding: 0 4px; }
    .error-banner .dismiss-btn:hover { opacity: 1; }
    .loading { color: var(--vscode-descriptionForeground); font-style: italic; padding: 16px 0; }
    .empty { color: var(--vscode-descriptionForeground); padding: 24px 0; text-align: center; }
    .search-box { min-width: 200px; }
    .project-label { font-weight: 600; padding: 6px 14px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: var(--radius); font-size: 0.95em; }
    .pipeline-label { font-weight: 500; padding: 6px 14px; background: var(--vscode-editor-inactiveSelectionBackground); color: var(--vscode-foreground); border-radius: var(--radius); font-size: 0.95em; display: none; }
    .pipeline-label.visible { display: inline-flex; align-items: center; gap: 4px; }
    .breadcrumb-sep { color: var(--vscode-descriptionForeground); font-size: 0.9em; display: none; }
    .breadcrumb-sep.visible { display: inline; }
    .pipeline-count { font-size: 0.85em; color: var(--vscode-descriptionForeground); padding: 8px 0; }
    .load-more-bar { text-align: center; padding: 12px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>\uD83D\uDD27 Pipeline Dashboard</h1>
    <div class="header-controls">
      <span class="project-label">\uD83D\uDCC2 ${projectLabel}${repoLabel}</span>
      <span id="breadcrumbSep" class="breadcrumb-sep">\u203A</span>
      <span id="pipelineLabel" class="pipeline-label"></span>
      <input type="text" id="searchBox" class="search-box" placeholder="Filter pipelines..." oninput="onSearch()">
      <button class="btn-icon" onclick="refreshAll()" title="Refresh">\uD83D\uDD04</button>
      ${pipelinesUrl ? `<button class="btn-icon" onclick="openUrl('${this._escapeHtml(pipelinesUrl)}')" title="Open in Browser">\uD83D\uDD17</button>` : ''}
    </div>
  </div>
  <div class="content">
    <div id="errorBanner" class="error-banner"></div>
    <div id="loadingMsg" class="loading">${this._project ? 'Loading pipelines...' : 'No project selected.'}</div>
    <div id="pipelineArea" style="display:none">
      <div id="pipelineCount" class="pipeline-count"></div>
      <div id="pipelineGrid" class="pipeline-grid"></div>
      <div id="emptyMsg" class="empty" style="display:none">No pipelines found for this project.</div>
    </div>
    <div id="buildDetailArea" style="display:none">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
        <button class="btn-secondary btn-sm" onclick="backToPipelines()">\u2190 Back</button>
        <h2 id="buildDetailTitle" style="margin:0;font-size:1.1em;"></h2>
      </div>
      <table class="builds-table" id="buildsTable">
        <thead><tr><th>Run</th><th>Status</th><th>Branch</th><th>Triggered by</th><th>Duration</th><th></th></tr></thead>
        <tbody id="buildsBody"></tbody>
      </table>
      <div id="timelineArea" class="timeline-panel"></div>
    </div>
  </div>
  <div id="runModal" class="modal-overlay">
    <div class="modal">
      <h2>\u25B6 Run Pipeline</h2>
      <div class="field"><label>Pipeline</label><input type="text" id="runPipelineName" disabled></div>
      <div class="field"><label>Branch (optional)</label><input type="text" id="runBranch" placeholder="main"></div>
      <div id="runError" class="error-banner"></div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="closeRunModal()">Cancel</button>
        <button class="btn-primary" onclick="submitRun()">Run</button>
      </div>
    </div>
  </div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }

  private _escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  dispose() {
    PipelineDashboardPanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach(d => d.dispose());
  }
}
