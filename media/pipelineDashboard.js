// Pipeline Dashboard webview script — loaded as external file (no escaping issues)
(function () {
  var vscode = acquireVsCodeApi();
  var allPipelines = [];
  var currentProject = '';
  var currentDefinitionId = null;
  var currentBuildId = null;
  var autoRefreshTimer = null;
  var PAGE_SIZE = 50;
  var displayCount = PAGE_SIZE;
  var dataReceived = false;
  var viewMode = 'flat'; // 'flat' or 'grouped'
  var favorites = new Set();
  var releaseDefinitions = [];
  var releasesLoaded = false;
  var currentReleaseDefId = null;
  var containerImageTemplate = '';
  var autoDeployEnabled = false;
  var wasRunning = false;
  var currentBuildForTimeline = null;
  var autoDeployReleaseDefs = [];
  var autoDeploySelectedDefId = null;
  var autoDeploySelectedEnv = null;
  var autoDeployEnvs = [];

  function escapeHtml(s) {
    if (!s) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escapeAttr(s) {
    if (!s) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/'/g, '&#39;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function buildImageName(build) {
    if (!containerImageTemplate || !build) return '';
    var buildNumber = build.buildNumber || '';
    var definitionName = (build.definitionName || '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '-');
    var branch = (build.sourceBranch || '').replace(/^refs\/heads\//, '');
    var shortCommit = (build.sourceVersion || '').substring(0, 8);
    return containerImageTemplate
      .replace(/\{buildNumber\}/g, buildNumber)
      .replace(/\{definitionName\}/g, definitionName)
      .replace(/\{branch\}/g, branch)
      .replace(/\{shortCommit\}/g, shortCommit);
  }

  function copyImageName(build) {
    var imageName = buildImageName(build);
    if (!imageName) return;
    vscode.postMessage({ command: 'copyToClipboard', text: imageName });
  }

  function normalizeStatus(status) {
    if (typeof status === 'number') return status;
    if (typeof status !== 'string') return null;
    var s = status.toLowerCase();
    if (s === 'inprogress' || s === 'in_progress' || s === 'running') return 1;
    if (s === 'completed' || s === 'complete') return 2;
    if (s === 'notstarted' || s === 'not_started' || s === 'queued') return 32;
    if (s === 'postponed') return 8;
    if (s === 'cancelling') return 4;
    return null;
  }

  function normalizeResult(result) {
    if (typeof result === 'number') return result;
    if (typeof result !== 'string') return null;
    var r = result.toLowerCase();
    if (r === 'succeeded' || r === 'success') return 2;
    if (r === 'failed' || r === 'failure') return 8;
    if (r === 'canceled' || r === 'cancelled') return 32;
    if (
      r === 'partiallysucceeded' ||
      r === 'partiallysucceeded' ||
      r === 'partial'
    )
      return 4;
    if (r === 'none') return 0;
    return null;
  }

  function statusBadge(status, result) {
    var normalizedStatus = normalizeStatus(status);
    var normalizedResult = normalizeResult(result);
    if (normalizedStatus === 1)
      return '<span class="build-badge inprogress">\u23F3 Running</span>';
    if (normalizedStatus !== null && normalizedStatus !== 2)
      return (
        '<span class="build-badge none">' +
        escapeHtml(String(status)) +
        '</span>'
      );
    if (normalizedResult === 2)
      return '<span class="build-badge succeeded">\u2705 Succeeded</span>';
    if (normalizedResult === 8)
      return '<span class="build-badge failed">\u274C Failed</span>';
    if (normalizedResult === 32)
      return '<span class="build-badge canceled">\uD83D\uDEAB Canceled</span>';
    if (normalizedResult === 4)
      return '<span class="build-badge partial">\u26A0\uFE0F Partial</span>';
    if (normalizedStatus === 2)
      return '<span class="build-badge none">Completed</span>';
    return '<span class="build-badge none">\u2014</span>';
  }

  function statusIcon(state, result) {
    if (state === 1) return '<span class="status-icon">\u23F3</span>';
    if (state === 0) return '<span class="status-icon">\u23F8</span>';
    if (result === 0) return '<span class="status-icon">\u2705</span>';
    if (result === 1) return '<span class="status-icon">\u26A0\uFE0F</span>';
    if (result === 2) return '<span class="status-icon">\u274C</span>';
    if (result === 3) return '<span class="status-icon">\uD83D\uDEAB</span>';
    if (result === 4) return '<span class="status-icon">\u23ED</span>';
    return '<span class="status-icon">\u26AA</span>';
  }

  function duration(start, end) {
    if (!start) return '\u2014';
    var sec = Math.floor(
      ((end ? new Date(end) : new Date()) - new Date(start)) / 1000,
    );
    if (sec < 60) return sec + 's';
    var min = Math.floor(sec / 60);
    if (min < 60) return min + 'm ' + (sec % 60) + 's';
    return Math.floor(min / 60) + 'h ' + (min % 60) + 'm';
  }

  function timeAgo(date) {
    if (!date) return '';
    var sec = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (sec < 60) return sec + 's ago';
    var min = Math.floor(sec / 60);
    if (min < 60) return min + 'm ago';
    var hrs = Math.floor(min / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
  }

  function formatDateTime(date) {
    if (!date) return '\u2014';
    var d = new Date(date);
    var month = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    var hrs = String(d.getHours()).padStart(2, '0');
    var mins = String(d.getMinutes()).padStart(2, '0');
    return month + '/' + day + ' ' + hrs + ':' + mins;
  }

  function showError(msg) {
    var el = document.getElementById('errorBanner');
    el.textContent = '';
    var span = document.createElement('span');
    span.textContent = msg;
    el.appendChild(span);
    var btn = document.createElement('button');
    btn.className = 'dismiss-btn';
    btn.textContent = '\u2715';
    btn.onclick = function () {
      el.classList.remove('visible');
    };
    el.appendChild(btn);
    el.classList.add('visible');
    document.getElementById('loadingMsg').style.display = 'none';
  }

  function renderPipelines() {
    var q = document.getElementById('searchBox').value.toLowerCase();
    var filtered = allPipelines.filter(function (p) {
      return (
        !q ||
        (p.name && p.name.toLowerCase().indexOf(q) >= 0) ||
        (p.path || '').toLowerCase().indexOf(q) >= 0
      );
    });
    var grid = document.getElementById('pipelineGrid');
    var empty = document.getElementById('emptyMsg');
    if (filtered.length === 0) {
      grid.innerHTML = '';
      empty.style.display = 'block';
      document.getElementById('pipelineCount').textContent = '';
      return;
    }
    empty.style.display = 'none';

    // Separate favorites
    var favPipelines = filtered.filter(function (p) {
      return favorites.has(p.id);
    });
    var otherPipelines = filtered.filter(function (p) {
      return !favorites.has(p.id);
    });

    grid.innerHTML = '';

    if (viewMode === 'grouped') {
      // Show favorites first
      if (favPipelines.length > 0) {
        appendGroup(grid, '\u2B50 Favorites', favPipelines, true);
      }
      // Group remaining by path
      var groups = {};
      otherPipelines.forEach(function (p) {
        var groupKey =
          p.path && p.path !== '\\' ? p.path.replace(/^\\/, '') : 'Other';
        if (!groups[groupKey]) {
          groups[groupKey] = [];
        }
        groups[groupKey].push(p);
      });
      var sortedKeys = Object.keys(groups).sort();
      sortedKeys.forEach(function (key) {
        appendGroup(grid, key, groups[key], false);
      });
      var total = filtered.length;
      document.getElementById('pipelineCount').textContent =
        total +
        ' pipeline' +
        (total !== 1 ? 's' : '') +
        ' in ' +
        (sortedKeys.length + (favPipelines.length > 0 ? 1 : 0)) +
        ' group' +
        (sortedKeys.length + (favPipelines.length > 0 ? 1 : 0) !== 1
          ? 's'
          : '');
    } else {
      // Flat view: favorites on top
      var ordered = favPipelines.concat(otherPipelines);
      var showing = ordered.slice(0, displayCount);
      document.getElementById('pipelineCount').textContent =
        'Showing ' + showing.length + ' of ' + ordered.length + ' pipelines';
      showing.forEach(function (p) {
        grid.appendChild(createPipelineCard(p));
      });

      if (ordered.length > displayCount) {
        var more = document.createElement('div');
        more.className = 'load-more-bar';
        var moreBtn = document.createElement('button');
        moreBtn.className = 'btn-secondary';
        moreBtn.textContent =
          'Show more (' + (ordered.length - displayCount) + ' remaining)';
        moreBtn.onclick = function () {
          window.loadMore();
        };
        more.appendChild(moreBtn);
        grid.appendChild(more);
      }
    }
  }

  function appendGroup(container, title, pipelines, expanded) {
    var header = document.createElement('div');
    header.className = 'group-header';
    header.innerHTML =
      '<span class="chevron' +
      (expanded ? '' : ' collapsed') +
      '">\u25BC</span>' +
      '<span>' +
      escapeHtml(title) +
      ' (' +
      pipelines.length +
      ')</span>';
    header.onclick = function () {
      var content = header.nextElementSibling;
      var chev = header.querySelector('.chevron');
      if (content) content.classList.toggle('hidden');
      if (chev) chev.classList.toggle('collapsed');
    };
    container.appendChild(header);
    var content = document.createElement('div');
    content.className =
      'group-content pipeline-grid' + (expanded ? '' : ' hidden');
    pipelines.forEach(function (p) {
      content.appendChild(createPipelineCard(p));
    });
    container.appendChild(content);
  }

  function createPipelineCard(p) {
    var card = document.createElement('div');
    card.className = 'pipeline-card';

    var latest = p.latestBuild;
    var badgeHtml = latest
      ? statusBadge(latest.status, latest.result)
      : '<span class="build-badge none">No runs</span>';

    var headerDiv = document.createElement('div');
    headerDiv.className = 'pipeline-card-header';

    // Favorite button
    var favBtn = document.createElement('button');
    favBtn.className = 'fav-btn' + (favorites.has(p.id) ? ' favorited' : '');
    favBtn.textContent = favorites.has(p.id) ? '\u2B50' : '\u2606';
    favBtn.title = favorites.has(p.id)
      ? 'Remove from favorites'
      : 'Add to favorites';
    favBtn.onclick = (function (id) {
      return function (e) {
        e.stopPropagation();
        vscode.postMessage({ command: 'toggleFavorite', definitionId: id });
      };
    })(p.id);
    headerDiv.appendChild(favBtn);

    var nameDiv = document.createElement('div');
    nameDiv.style.flex = '1';
    nameDiv.style.minWidth = '0';
    var nameInner = document.createElement('div');
    nameInner.className = 'pipeline-name';
    nameInner.textContent = p.name || '';
    nameDiv.appendChild(nameInner);
    if (p.path && p.path !== '\\') {
      var pathDiv = document.createElement('div');
      pathDiv.className = 'pipeline-path';
      pathDiv.textContent = p.path;
      nameDiv.appendChild(pathDiv);
    }
    headerDiv.appendChild(nameDiv);
    var badgeSpan = document.createElement('span');
    badgeSpan.innerHTML = badgeHtml;
    headerDiv.appendChild(badgeSpan);
    card.appendChild(headerDiv);

    var bodyDiv = document.createElement('div');
    bodyDiv.className = 'pipeline-card-body';
    if (latest) {
      var infoDiv = document.createElement('div');
      infoDiv.className = 'build-info';
      infoDiv.textContent =
        '#' +
        (latest.buildNumber || '') +
        ' \u00B7 ' +
        (latest.sourceBranch || '').replace('refs/heads/', '') +
        ' \u00B7 ' +
        timeAgo(latest.finishTime);
      bodyDiv.appendChild(infoDiv);
    }
    card.appendChild(bodyDiv);

    var actionsDiv = document.createElement('div');
    actionsDiv.className = 'pipeline-card-actions';

    var viewBtn = document.createElement('button');
    viewBtn.className = 'btn-secondary btn-sm';
    viewBtn.textContent = 'View Runs';
    actionsDiv.appendChild(viewBtn);

    var runBtn = document.createElement('button');
    runBtn.className = 'btn-primary btn-sm';
    runBtn.textContent = '\u25B6 Run';
    runBtn.onclick = (function (id, name) {
      return function () {
        window.openRunModal(id, name);
      };
    })(p.id, p.name);
    actionsDiv.appendChild(runBtn);

    if (containerImageTemplate && latest) {
      var copyBtn = document.createElement('button');
      copyBtn.className = 'btn-icon btn-sm';
      copyBtn.textContent = '\uD83D\uDCCB';
      copyBtn.title = 'Copy image name';
      copyBtn.onclick = (function (build) {
        return function (e) {
          e.stopPropagation();
          copyImageName(build);
        };
      })(latest);
      actionsDiv.appendChild(copyBtn);
    }

    var openUrl =
      p.latestBuild && p.latestBuild.url ? p.latestBuild.url : p.url;
    if (openUrl) {
      var linkBtn = document.createElement('button');
      linkBtn.className = 'btn-icon btn-sm';
      linkBtn.textContent = '\uD83D\uDD17';
      linkBtn.title = 'Open in browser';
      linkBtn.onclick = (function (url) {
        return function () {
          window.openUrl(url);
        };
      })(openUrl);
      actionsDiv.appendChild(linkBtn);
    }

    viewBtn.onclick = (function (id, name, pUrl) {
      return function () {
        window.viewBuilds(id, name, pUrl);
      };
    })(p.id, p.name, p.url || openUrl);
    card.appendChild(actionsDiv);
    return card;
  }

  window.loadMore = function () {
    displayCount += PAGE_SIZE;
    renderPipelines();
  };
  window.onSearch = function () {
    displayCount = PAGE_SIZE;
    renderPipelines();
  };

  window.refreshAll = function () {
    if (currentDefinitionId !== null) {
      vscode.postMessage({
        command: 'loadBuilds',
        definitionId: currentDefinitionId,
        project: currentProject,
      });
    } else if (currentProject) {
      document.getElementById('loadingMsg').style.display = 'block';
      document.getElementById('pipelineArea').style.display = 'none';
      vscode.postMessage({ command: 'loadPipelines', project: currentProject });
    }
  };

  window.viewBuilds = function (definitionId, name, pipelineUrl) {
    currentDefinitionId = definitionId;
    document.getElementById('pipelineLabel').textContent =
      '\u2699\uFE0F ' + name;
    document.getElementById('pipelineLabel').classList.add('visible');
    document.getElementById('breadcrumbSep').classList.add('visible');
    document.getElementById('pipelineArea').style.display = 'none';
    document.getElementById('buildDetailArea').style.display = 'block';
    document.getElementById('buildDetailTitle').textContent =
      name + ' \u2014 Recent Runs';
    var headerBtn = document.getElementById('headerOpenBtn');
    if (headerBtn && pipelineUrl) {
      headerBtn.onclick = (function (url) {
        return function () {
          window.openUrl(url);
        };
      })(pipelineUrl);
    }
    document.getElementById('buildsBody').innerHTML = '';
    var loadingRow = document.createElement('tr');
    var loadingCell = document.createElement('td');
    loadingCell.colSpan = 8;
    loadingCell.className = 'loading';
    loadingCell.textContent = 'Loading...';
    loadingRow.appendChild(loadingCell);
    document.getElementById('buildsBody').appendChild(loadingRow);
    document.getElementById('timelineArea').innerHTML = '';
    document.getElementById('buildChangesArea').innerHTML = '';
    vscode.postMessage({
      command: 'loadBuilds',
      definitionId: definitionId,
      project: currentProject,
    });
  };

  window.backToPipelines = function () {
    currentDefinitionId = null;
    currentBuildId = null;
    autoDeployEnabled = false;
    wasRunning = false;
    currentBuildForTimeline = null;
    autoDeployReleaseDefs = [];
    autoDeploySelectedDefId = null;
    autoDeploySelectedEnv = null;
    autoDeployEnvs = [];
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    document.getElementById('pipelineLabel').classList.remove('visible');
    document.getElementById('breadcrumbSep').classList.remove('visible');
    document.getElementById('buildDetailArea').style.display = 'none';
    document.getElementById('pipelineArea').style.display = 'block';
    var headerBtn = document.getElementById('headerOpenBtn');
    if (headerBtn) {
      var defaultUrl = headerBtn.dataset.defaultUrl;
      if (defaultUrl) {
        headerBtn.onclick = (function (url) {
          return function () {
            window.openUrl(url);
          };
        })(defaultUrl);
      }
    }
  };

  window.viewTimeline = function (buildId, buildNumber, build) {
    currentBuildId = buildId;
    currentBuildForTimeline = build || null;
    wasRunning = false;
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    var area = document.getElementById('timelineArea');
    area.textContent = '';
    var loadDiv = document.createElement('div');
    loadDiv.className = 'loading';
    loadDiv.textContent = 'Loading stages for #' + buildNumber + '...';
    area.appendChild(loadDiv);
    vscode.postMessage({
      command: 'loadTimeline',
      buildId: buildId,
      project: currentProject,
    });
    vscode.postMessage({
      command: 'loadBuildChanges',
      buildId: buildId,
      project: currentProject,
    });
  };

  window.toggleCollapse = function (el) {
    var c = el.nextElementSibling;
    var ch = el.querySelector('.chevron');
    if (c) c.classList.toggle('hidden');
    if (ch) ch.classList.toggle('collapsed');
  };

  window.openRunModal = function (definitionId, name) {
    document.getElementById('runPipelineName').value = name;
    var sel = document.getElementById('runBranch');
    sel.innerHTML = '<option value="">-- loading branches... --</option>';
    document.getElementById('runParamsArea').innerHTML =
      '<div class="loading">Loading pipeline parameters...</div>';
    document.getElementById('runModal').classList.add('visible');
    document.getElementById('runModal').dataset.definitionId =
      String(definitionId);
    vscode.postMessage({ command: 'loadBranches' });
    vscode.postMessage({
      command: 'loadPipelineParameters',
      definitionId: definitionId,
      project: currentProject,
    });
  };

  window.closeRunModal = function () {
    document.getElementById('runModal').classList.remove('visible');
  };

  window.submitRun = function () {
    var defId = parseInt(
      document.getElementById('runModal').dataset.definitionId,
    );
    var branch = document.getElementById('runBranch').value.trim();
    // Collect variable overrides
    var parameters = {};
    var hasParams = false;
    document.querySelectorAll('.run-variable').forEach(function (el) {
      var val = el.value.trim();
      if (val !== '' && val !== el.dataset.defaultValue) {
        parameters[el.dataset.name] = val;
        hasParams = true;
      }
    });
    // Collect template parameter overrides
    var templateParameters = {};
    var hasTemplateParams = false;
    // Text inputs and selects
    document.querySelectorAll('.run-template-param').forEach(function (el) {
      var name = el.dataset.name;
      var val;
      if (el.type === 'checkbox') {
        val = el.checked ? 'true' : 'false';
      } else if (el.tagName === 'SELECT') {
        val = el.value;
      } else {
        val = el.value.trim();
      }
      if (val !== '' && val !== el.dataset.defaultValue) {
        templateParameters[name] = val;
        hasTemplateParams = true;
      }
    });
    // Radio buttons
    var radioNames = {};
    document
      .querySelectorAll('.run-template-param-radio:checked')
      .forEach(function (el) {
        var name = el.dataset.name;
        if (!radioNames[name]) {
          radioNames[name] = true;
          var val = el.value;
          if (val !== el.dataset.defaultValue) {
            templateParameters[name] = val;
            hasTemplateParams = true;
          }
        }
      });
    vscode.postMessage({
      command: 'queueBuild',
      definitionId: defId,
      branch: branch,
      parameters: hasParams ? parameters : undefined,
      templateParameters: hasTemplateParams ? templateParameters : undefined,
      project: currentProject,
    });
    window.closeRunModal();
  };

  window.openUrl = function (url) {
    vscode.postMessage({ command: 'openInBrowser', url: url });
  };

  window.setViewMode = function (mode) {
    viewMode = mode;
    document.getElementById('viewFlat').className =
      'btn-secondary btn-sm' + (mode === 'flat' ? ' active' : '');
    document.getElementById('viewGrouped').className =
      'btn-secondary btn-sm' + (mode === 'grouped' ? ' active' : '');
    displayCount = PAGE_SIZE;
    renderPipelines();
  };

  window.switchViewTab = function (tabId) {
    document.querySelectorAll('.view-tab').forEach(function (t) {
      t.classList.remove('active');
    });
    document.querySelectorAll('.view-tab-content').forEach(function (t) {
      t.classList.remove('active');
    });
    document
      .querySelector('.view-tab[data-tab="' + tabId + '"]')
      .classList.add('active');
    document.getElementById('tab-' + tabId).classList.add('active');

    if (tabId === 'releases' && !releasesLoaded && currentProject) {
      releasesLoaded = true;
      vscode.postMessage({
        command: 'loadReleaseDefinitions',
        project: currentProject,
      });
    }
  };

  // --- Release functions ---
  function renderReleaseDefinitions(definitions) {
    var grid = document.getElementById('releaseDefGrid');
    var empty = document.getElementById('releaseEmptyMsg');
    document.getElementById('releaseLoadingMsg').style.display = 'none';
    document.getElementById('releaseArea').style.display = 'block';
    document.getElementById('releaseDetailArea').style.display = 'none';

    if (!definitions || definitions.length === 0) {
      grid.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    grid.innerHTML = '';

    definitions.forEach(function (d) {
      var card = document.createElement('div');
      card.className = 'pipeline-card';

      var headerDiv = document.createElement('div');
      headerDiv.className = 'pipeline-card-header';
      var nameDiv = document.createElement('div');
      nameDiv.style.flex = '1';
      var nameInner = document.createElement('div');
      nameInner.className = 'pipeline-name';
      nameInner.textContent = d.name || '';
      nameDiv.appendChild(nameInner);
      if (d.path && d.path !== '\\') {
        var pathDiv = document.createElement('div');
        pathDiv.className = 'pipeline-path';
        pathDiv.textContent = d.path;
        nameDiv.appendChild(pathDiv);
      }
      headerDiv.appendChild(nameDiv);
      card.appendChild(headerDiv);

      var actionsDiv = document.createElement('div');
      actionsDiv.className = 'pipeline-card-actions';

      var viewBtn = document.createElement('button');
      viewBtn.className = 'btn-secondary btn-sm';
      viewBtn.textContent = 'View Releases';
      viewBtn.onclick = (function (id, name) {
        return function () {
          window.viewReleases(id, name);
        };
      })(d.id, d.name);
      actionsDiv.appendChild(viewBtn);

      var createBtn = document.createElement('button');
      createBtn.className = 'btn-primary btn-sm';
      createBtn.textContent = '\uD83D\uDE80 Create Release';
      createBtn.onclick = (function (id, name) {
        return function () {
          window.openReleaseModal(id, name);
        };
      })(d.id, d.name);
      actionsDiv.appendChild(createBtn);

      if (d.url) {
        var linkBtn = document.createElement('button');
        linkBtn.className = 'btn-icon btn-sm';
        linkBtn.textContent = '\uD83D\uDD17';
        linkBtn.title = 'Open in browser';
        linkBtn.onclick = (function (url) {
          return function () {
            window.openUrl(url);
          };
        })(d.url);
        actionsDiv.appendChild(linkBtn);
      }

      card.appendChild(actionsDiv);
      grid.appendChild(card);
    });
  }

  window.viewReleases = function (definitionId, name) {
    currentReleaseDefId = definitionId;
    document.getElementById('releaseArea').style.display = 'none';
    document.getElementById('releaseDetailArea').style.display = 'block';
    document.getElementById('releaseDetailTitle').textContent =
      name + ' \u2014 Recent Releases';
    document.getElementById('releasesList').innerHTML =
      '<div class="loading">Loading releases...</div>';
    vscode.postMessage({
      command: 'loadReleases',
      definitionId: definitionId,
      project: currentProject,
    });
  };

  window.backToReleaseDefinitions = function () {
    currentReleaseDefId = null;
    document.getElementById('releaseDetailArea').style.display = 'none';
    document.getElementById('releaseArea').style.display = 'block';
  };

  window.openReleaseModal = function (definitionId, name) {
    document.getElementById('releaseDefName').value = name;
    document.getElementById('releaseDescription').value = '';
    document.getElementById('releaseArtifactsArea').innerHTML =
      '<div class="loading">Loading artifact sources...</div>';
    document.getElementById('releaseModal').classList.add('visible');
    document.getElementById('releaseModal').dataset.definitionId =
      String(definitionId);
    vscode.postMessage({
      command: 'loadReleaseDefinitionDetail',
      definitionId: definitionId,
      project: currentProject,
    });
  };

  window.closeReleaseModal = function () {
    document.getElementById('releaseModal').classList.remove('visible');
  };

  window.submitRelease = function () {
    var defId = parseInt(
      document.getElementById('releaseModal').dataset.definitionId,
    );
    var desc = document.getElementById('releaseDescription').value.trim();
    // Collect artifact overrides
    var artifactRows = document.querySelectorAll('.artifact-row');
    var artifacts = [];
    artifactRows.forEach(function (row) {
      var alias = row.dataset.alias;
      var branch = row.querySelector('.artifact-branch');
      var version = row.querySelector('.artifact-version');
      var art = { alias: alias };
      if (branch && branch.value) {
        art.branch = branch.value;
      }
      if (version && version.value.trim()) {
        art.version = version.value.trim();
      }
      artifacts.push(art);
    });
    vscode.postMessage({
      command: 'createRelease',
      definitionId: defId,
      description: desc,
      artifacts: artifacts.length > 0 ? artifacts : undefined,
      project: currentProject,
    });
    window.closeReleaseModal();
  };

  // --- Deploy from build functions ---
  var deployBuildData = null;

  window.openDeployModal = function (build) {
    deployBuildData = build;
    var modal = document.getElementById('deployModal');
    document.getElementById('deployBuildLabel').textContent =
      '#' + (build.buildNumber || '') + ' \u00B7 ' + (build.sourceBranch || '');
    document.getElementById('deployDefSelect').innerHTML =
      '<option value="">-- loading release definitions... --</option>';
    document.getElementById('deployDefSelect').disabled = true;
    modal.classList.add('visible');
    vscode.postMessage({
      command: 'loadDeployOptions',
      buildDefinitionId: currentDefinitionId,
      project: currentProject,
    });
  };

  window.closeDeployModal = function () {
    document.getElementById('deployModal').classList.remove('visible');
    deployBuildData = null;
  };

  window.submitDeploy = function () {
    var defId = parseInt(document.getElementById('deployDefSelect').value);
    if (!defId || !deployBuildData) return;
    vscode.postMessage({
      command: 'deployBuild',
      releaseDefinitionId: defId,
      buildNumber: deployBuildData.buildNumber,
      sourceBranch: deployBuildData.sourceBranch,
      project: currentProject,
    });
    window.closeDeployModal();
  };

  function renderReleases(releases) {
    var container = document.getElementById('releasesList');
    container.innerHTML = '';
    if (!releases || releases.length === 0) {
      container.innerHTML = '<div class="empty">No releases found.</div>';
      return;
    }

    releases.forEach(function (r) {
      var card = document.createElement('div');
      card.className = 'release-card';

      var header = document.createElement('div');
      header.className = 'release-card-header';
      var nameSpan = document.createElement('span');
      nameSpan.className = 'release-name';
      nameSpan.textContent = r.name || 'Release #' + r.id;
      header.appendChild(nameSpan);
      if (r.url) {
        var linkBtn = document.createElement('button');
        linkBtn.className = 'btn-icon btn-sm';
        linkBtn.textContent = '\uD83D\uDD17';
        linkBtn.title = 'Open in browser';
        linkBtn.onclick = (function (url) {
          return function () {
            window.openUrl(url);
          };
        })(r.url);
        header.appendChild(linkBtn);
      }
      card.appendChild(header);

      var meta = document.createElement('div');
      meta.className = 'release-meta';
      var parts = [];
      if (r.createdBy) parts.push(r.createdBy);
      if (r.createdOn) parts.push(timeAgo(r.createdOn));
      if (r.description) parts.push(r.description);
      meta.textContent = parts.join(' \u00B7 ');
      card.appendChild(meta);

      if (r.environments && r.environments.length > 0) {
        var envs = document.createElement('div');
        envs.className = 'release-envs';
        r.environments.forEach(function (env) {
          var badge = document.createElement('span');
          var envStatus = normalizeReleaseEnvStatus(env.status);
          badge.className = 'release-env ' + envStatus;
          badge.textContent = env.name + ': ' + envStatus;
          envs.appendChild(badge);
        });
        card.appendChild(envs);
      }

      container.appendChild(card);
    });
  }

  function normalizeReleaseEnvStatus(status) {
    if (typeof status === 'number') {
      // EnvironmentStatus enum: 1=NotStarted, 2=InProgress, 4=Succeeded, 8=Canceled, 16=Rejected, 32=Queued, 64=Scheduled, 128=PartiallySucceeded
      if (status === 4) return 'succeeded';
      if (status === 2 || status === 32 || status === 64) return 'inprogress';
      if (status === 16 || status === 8) return 'rejected';
      return 'notstarted';
    }
    var s = String(status || '').toLowerCase();
    if (s.indexOf('succeed') >= 0) return 'succeeded';
    if (s.indexOf('progress') >= 0 || s.indexOf('queue') >= 0)
      return 'inprogress';
    if (s.indexOf('reject') >= 0 || s.indexOf('cancel') >= 0) return 'rejected';
    return 'notstarted';
  }

  function renderBuilds(builds) {
    var tbody = document.getElementById('buildsBody');
    tbody.innerHTML = '';
    if (!builds || builds.length === 0) {
      var emptyRow = document.createElement('tr');
      var emptyCell = document.createElement('td');
      emptyCell.colSpan = 8;
      emptyCell.className = 'empty';
      emptyCell.textContent = 'No runs found.';
      emptyRow.appendChild(emptyCell);
      tbody.appendChild(emptyRow);
      return;
    }
    builds.forEach(function (b) {
      var tr = document.createElement('tr');
      tr.onclick = (function (id, num, build) {
        return function () {
          window.viewTimeline(id, num, build);
        };
      })(b.id, b.buildNumber, b);

      var tdRun = document.createElement('td');
      var runLink = document.createElement('span');
      runLink.className = 'link';
      runLink.textContent = '#' + (b.buildNumber || '');
      tdRun.appendChild(runLink);
      tr.appendChild(tdRun);

      var tdStatus = document.createElement('td');
      tdStatus.innerHTML = statusBadge(b.status, b.result);
      tr.appendChild(tdStatus);

      var tdBranch = document.createElement('td');
      tdBranch.textContent = b.sourceBranch || '';
      tr.appendChild(tdBranch);

      var tdBy = document.createElement('td');
      tdBy.textContent = b.requestedFor || '';
      tr.appendChild(tdBy);

      var tdStarted = document.createElement('td');
      tdStarted.textContent = formatDateTime(b.queueTime || b.startTime);
      tdStarted.title = b.queueTime
        ? new Date(b.queueTime).toLocaleString()
        : '';
      tr.appendChild(tdStarted);

      var tdFinished = document.createElement('td');
      tdFinished.textContent = formatDateTime(b.finishTime);
      tdFinished.title = b.finishTime
        ? new Date(b.finishTime).toLocaleString()
        : '';
      tr.appendChild(tdFinished);

      var tdDuration = document.createElement('td');
      tdDuration.textContent = duration(b.startTime, b.finishTime);
      tr.appendChild(tdDuration);

      var tdActions = document.createElement('td');
      // Deploy button — show for completed builds (status=2 means completed)
      var buildStatus = normalizeStatus(b.status);
      var buildResult = normalizeResult(b.result);
      if (buildStatus === 2 && buildResult === 2) {
        var deployBtn = document.createElement('button');
        deployBtn.className = 'btn-icon btn-sm';
        deployBtn.textContent = '\uD83D\uDE80';
        deployBtn.title = 'Deploy this build';
        deployBtn.onclick = (function (build) {
          return function (e) {
            e.stopPropagation();
            window.openDeployModal(build);
          };
        })(b);
        tdActions.appendChild(deployBtn);
      }
      if (containerImageTemplate) {
        var copyBtn = document.createElement('button');
        copyBtn.className = 'btn-icon btn-sm';
        copyBtn.textContent = '\uD83D\uDCCB';
        copyBtn.title = 'Copy image name';
        copyBtn.onclick = (function (build) {
          return function (e) {
            e.stopPropagation();
            copyImageName(build);
          };
        })(b);
        tdActions.appendChild(copyBtn);
      }
      if (b.url) {
        var openBtn = document.createElement('button');
        openBtn.className = 'btn-icon btn-sm';
        openBtn.textContent = '\uD83D\uDD17';
        openBtn.title = 'Open in browser';
        openBtn.onclick = (function (url) {
          return function (e) {
            e.stopPropagation();
            window.openUrl(url);
          };
        })(b.url);
        tdActions.appendChild(openBtn);
      }
      tr.appendChild(tdActions);
      tbody.appendChild(tr);
    });
  }

  function renderTimeline(stages) {
    var area = document.getElementById('timelineArea');
    area.innerHTML = '';
    if (!stages || stages.length === 0) {
      var emptyDiv = document.createElement('div');
      emptyDiv.className = 'empty';
      emptyDiv.textContent = 'No stage information available.';
      area.appendChild(emptyDiv);
      return;
    }

    var totalTasks = 0,
      completedTasks = 0,
      hasRunning = false,
      hasFailed = false;
    stages.forEach(function (s) {
      s.jobs.forEach(function (j) {
        j.tasks.forEach(function (t) {
          totalTasks++;
          if (t.state === 2) completedTasks++;
          if (t.state === 1) hasRunning = true;
          if (t.result === 2) hasFailed = true;
        });
      });
    });
    var pct =
      totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
    var cls = hasFailed ? 'failed' : hasRunning ? 'inprogress' : 'succeeded';

    var h3 = document.createElement('h3');
    h3.style.margin = '16px 0 8px';
    h3.textContent = 'Stages & Steps';
    area.appendChild(h3);

    // Overall progress bar
    var overall = document.createElement('div');
    overall.className = 'overall-progress';
    overall.innerHTML =
      '<span class="overall-progress-label">Overall</span>' +
      '<div class="progress-bar-container"><div class="progress-bar ' +
      cls +
      '" style="width:' +
      pct +
      '%"></div></div>' +
      '<span class="progress-pct">' +
      pct +
      '%</span>';
    area.appendChild(overall);

    if (hasRunning) {
      var note = document.createElement('div');
      note.className = 'auto-refresh-note';
      note.textContent = 'Auto-refreshing every 10s while running...';
      area.appendChild(note);

      // Auto-deploy checkbox
      if (currentBuildForTimeline) {
        var autoDeployDiv = document.createElement('div');
        autoDeployDiv.style.cssText =
          'margin:8px 0;display:flex;flex-direction:column;gap:8px;';
        var cbRow = document.createElement('div');
        cbRow.style.cssText = 'display:flex;align-items:center;gap:8px;';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.id = 'autoDeployCheckbox';
        cb.checked = autoDeployEnabled;
        cb.onchange = function () {
          autoDeployEnabled = cb.checked;
          var configArea = document.getElementById('autoDeployConfig');
          if (cb.checked) {
            configArea.style.display = 'flex';
            if (autoDeployReleaseDefs.length === 0) {
              vscode.postMessage({
                command: 'loadAutoDeployOptions',
                buildDefinitionId: currentDefinitionId,
                project: currentProject,
              });
            }
          } else {
            configArea.style.display = 'none';
          }
        };
        var lbl = document.createElement('label');
        lbl.htmlFor = 'autoDeployCheckbox';
        lbl.textContent = '\uD83D\uDE80 Auto-deploy when build succeeds';
        lbl.style.cssText = 'cursor:pointer;font-size:0.9em;';
        cbRow.appendChild(cb);
        cbRow.appendChild(lbl);
        autoDeployDiv.appendChild(cbRow);

        var configArea = document.createElement('div');
        configArea.id = 'autoDeployConfig';
        configArea.style.cssText =
          'display:' +
          (autoDeployEnabled ? 'flex' : 'none') +
          ';gap:8px;flex-wrap:wrap;padding-left:24px;';

        var defLabel = document.createElement('label');
        defLabel.textContent = 'Release Def:';
        defLabel.style.cssText = 'font-size:0.85em;align-self:center;';
        configArea.appendChild(defLabel);
        var defSel = document.createElement('select');
        defSel.id = 'autoDeployDefSelect';
        defSel.style.cssText = 'flex:1;min-width:140px;';
        if (autoDeployReleaseDefs.length === 0) {
          defSel.innerHTML = '<option value="">-- loading... --</option>';
          defSel.disabled = true;
        } else {
          defSel.innerHTML = '';
          autoDeployReleaseDefs.forEach(function (d) {
            var opt = document.createElement('option');
            opt.value = d.id;
            opt.textContent = d.name;
            if (autoDeploySelectedDefId && d.id === autoDeploySelectedDefId)
              opt.selected = true;
            defSel.appendChild(opt);
          });
          defSel.disabled = false;
        }
        defSel.onchange = function () {
          autoDeploySelectedDefId = parseInt(defSel.value) || null;
          // Load environments for selected def
          if (autoDeploySelectedDefId) {
            vscode.postMessage({
              command: 'loadAutoDeployEnvs',
              releaseDefinitionId: autoDeploySelectedDefId,
              project: currentProject,
            });
          }
        };
        configArea.appendChild(defSel);

        var envLabel = document.createElement('label');
        envLabel.textContent = 'Environment:';
        envLabel.style.cssText = 'font-size:0.85em;align-self:center;';
        configArea.appendChild(envLabel);
        var envSel = document.createElement('select');
        envSel.id = 'autoDeployEnvSelect';
        envSel.style.cssText = 'flex:1;min-width:140px;';
        if (autoDeployEnvs.length === 0) {
          envSel.innerHTML = '<option value="">All (default)</option>';
        } else {
          envSel.innerHTML = '<option value="">All environments</option>';
          autoDeployEnvs.forEach(function (env) {
            var opt = document.createElement('option');
            opt.value = env.name;
            opt.textContent = env.name;
            if (autoDeploySelectedEnv && env.name === autoDeploySelectedEnv)
              opt.selected = true;
            envSel.appendChild(opt);
          });
        }
        envSel.onchange = function () {
          autoDeploySelectedEnv = envSel.value || null;
        };
        configArea.appendChild(envSel);

        autoDeployDiv.appendChild(configArea);
        area.appendChild(autoDeployDiv);
      }
    }

    stages.forEach(function (stage) {
      var st = 0,
        sd = 0,
        sr = false,
        sf = false;
      stage.jobs.forEach(function (j) {
        j.tasks.forEach(function (t) {
          st++;
          if (t.state === 2) sd++;
          if (t.state === 1) sr = true;
          if (t.result === 2) sf = true;
        });
      });
      var sp = st > 0 ? Math.round((sd / st) * 100) : 0;
      var sc = sf ? 'failed' : sr ? 'inprogress' : 'succeeded';

      var stageDiv = document.createElement('div');
      stageDiv.className = 'stage';

      var stageHeader = document.createElement('div');
      stageHeader.className = 'stage-header';
      stageHeader.onclick = function () {
        window.toggleCollapse(stageHeader);
      };
      stageHeader.innerHTML =
        statusIcon(stage.state, stage.result) +
        '<span class="chevron">\u25BC</span>' +
        '<span class="stage-name">' +
        escapeHtml(stage.name) +
        '</span>' +
        '<span class="stage-duration">' +
        duration(stage.startTime, stage.finishTime) +
        '</span>';
      stageDiv.appendChild(stageHeader);

      var stageProgress = document.createElement('div');
      stageProgress.className = 'stage-progress';
      stageProgress.innerHTML =
        '<div class="progress-bar-container"><div class="progress-bar ' +
        sc +
        '" style="width:' +
        sp +
        '%"></div></div>' +
        '<span class="progress-pct">' +
        sp +
        '%</span>';
      stageDiv.appendChild(stageProgress);

      var stageContent = document.createElement('div');
      stageContent.className = 'collapsible-content';

      stage.jobs.forEach(function (job) {
        var jobDiv = document.createElement('div');
        jobDiv.className = 'job';

        var jobHeader = document.createElement('div');
        jobHeader.className = 'job-header';
        jobHeader.onclick = function () {
          window.toggleCollapse(jobHeader);
        };
        jobHeader.innerHTML =
          statusIcon(job.state, job.result) +
          '<span class="chevron">\u25BC</span>' +
          '<span class="job-name">' +
          escapeHtml(job.name) +
          '</span>' +
          '<span class="stage-duration">' +
          duration(job.startTime, job.finishTime) +
          '</span>';
        jobDiv.appendChild(jobHeader);

        var jobContent = document.createElement('div');
        jobContent.className = 'collapsible-content';

        job.tasks.forEach(function (task) {
          var taskDiv = document.createElement('div');
          taskDiv.className = 'task';
          taskDiv.innerHTML =
            statusIcon(task.state, task.result) +
            '<span class="task-name">' +
            escapeHtml(task.name) +
            '</span>' +
            '<span class="stage-duration">' +
            duration(task.startTime, task.finishTime) +
            '</span>';
          jobContent.appendChild(taskDiv);

          if (task.issues) {
            task.issues.forEach(function (issue) {
              var issueDiv = document.createElement('div');
              issueDiv.className = 'task-issue';
              issueDiv.textContent = '\u26A0 ' + issue.message;
              jobContent.appendChild(issueDiv);
            });
          }
        });

        jobDiv.appendChild(jobContent);
        stageContent.appendChild(jobDiv);
      });

      stageDiv.appendChild(stageContent);
      area.appendChild(stageDiv);
    });

    // Detect build completion transition: was running → now finished successfully
    if (
      wasRunning &&
      !hasRunning &&
      !hasFailed &&
      autoDeployEnabled &&
      currentBuildForTimeline
    ) {
      autoDeployEnabled = false; // one-shot
      var adNote = document.createElement('div');
      adNote.style.cssText =
        'margin:8px 0;padding:8px 12px;background:var(--vscode-editorInfo-background, rgba(0,120,212,0.1));border:1px solid var(--vscode-editorInfo-foreground, #007acc);border-radius:4px;font-size:0.9em;';
      adNote.textContent =
        '\uD83D\uDE80 Build succeeded! Triggering auto-deploy...';
      area.appendChild(adNote);
      vscode.postMessage({
        command: 'autoDeployBuild',
        buildDefinitionId: currentDefinitionId,
        releaseDefinitionId: autoDeploySelectedDefId || null,
        environment: autoDeploySelectedEnv || null,
        buildNumber: currentBuildForTimeline.buildNumber,
        sourceBranch: currentBuildForTimeline.sourceBranch,
        project: currentProject,
      });
    }
    wasRunning = hasRunning;

    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    if (hasRunning && currentBuildId) {
      autoRefreshTimer = setInterval(function () {
        vscode.postMessage({
          command: 'loadTimeline',
          buildId: currentBuildId,
          project: currentProject,
        });
      }, 10000);
    }
  }

  function renderBuildChanges(changes) {
    var changesDiv = document.getElementById('buildChangesArea');
    if (!changesDiv) return;
    changesDiv.innerHTML = '';
    changesDiv.style.marginTop = '16px';

    var header = document.createElement('div');
    header.className = 'stage-header';
    header.style.cursor = 'pointer';
    header.onclick = function () {
      window.toggleCollapse(header);
    };
    header.innerHTML =
      '<span class="chevron">\u25BC</span>' +
      '<span class="stage-name">\uD83D\uDCDD Changes (' +
      (changes ? changes.length : 0) +
      ')</span>';
    changesDiv.appendChild(header);

    var content = document.createElement('div');
    content.className = 'collapsible-content';

    if (!changes || changes.length === 0) {
      var emptyDiv = document.createElement('div');
      emptyDiv.className = 'empty';
      emptyDiv.style.padding = '8px 16px';
      emptyDiv.textContent = 'No changes associated with this build.';
      content.appendChild(emptyDiv);
    } else {
      changes.forEach(function (c) {
        var changeDiv = document.createElement('div');
        changeDiv.className = 'task';
        changeDiv.style.cssText =
          'display:flex;align-items:flex-start;gap:8px;padding:4px 8px;';

        var commitSpan = document.createElement('span');
        commitSpan.style.cssText =
          'font-family:var(--vscode-editor-font-family, monospace);font-size:0.85em;color:var(--vscode-textLink-foreground);white-space:nowrap;cursor:pointer;min-width:64px;';
        var shortId = (c.id || '').substring(0, 8);
        commitSpan.textContent = shortId;
        commitSpan.title = c.id || '';
        if (c.location) {
          commitSpan.onclick = (function (url) {
            return function (e) {
              e.stopPropagation();
              window.openUrl(url);
            };
          })(c.location);
        }
        changeDiv.appendChild(commitSpan);

        var msgSpan = document.createElement('span');
        msgSpan.style.cssText = 'flex:1;min-width:0;';
        var firstLine = (c.message || '').split('\n')[0];
        msgSpan.textContent = firstLine;
        msgSpan.title = c.message || '';
        changeDiv.appendChild(msgSpan);

        var metaSpan = document.createElement('span');
        metaSpan.style.cssText =
          'white-space:nowrap;font-size:0.85em;opacity:0.7;';
        var parts = [];
        if (c.author) parts.push(c.author);
        if (c.timestamp) parts.push(timeAgo(c.timestamp));
        metaSpan.textContent = parts.join(' \u00B7 ');
        changeDiv.appendChild(metaSpan);

        content.appendChild(changeDiv);
      });
    }

    changesDiv.appendChild(header);
    changesDiv.appendChild(content);
  }

  function renderReleaseArtifactFields(artifacts) {
    var container = document.getElementById('releaseArtifactsArea');
    if (!artifacts || artifacts.length === 0) {
      container.innerHTML = '';
      return;
    }
    var html = '';
    artifacts.forEach(function (art) {
      var hasImages = art.imageOptions && art.imageOptions.length > 0;
      html +=
        '<div class="artifact-row field" data-alias="' +
        escapeAttr(art.alias || '') +
        '">';
      html +=
        '<label><strong>' +
        escapeHtml(art.alias || 'Artifact') +
        '</strong> <span style="font-weight:normal;color:var(--vscode-descriptionForeground);">(' +
        escapeHtml(art.type || 'Build') +
        (art.definitionName ? ' - ' + escapeHtml(art.definitionName) : '') +
        ')</span></label>';
      html += '<div style="display:flex;gap:8px;flex-wrap:wrap;">';
      html +=
        '<div style="flex:1;min-width:160px;"><label style="font-size:0.85em;">Branch</label><select class="artifact-branch" data-default-branch="' +
        escapeAttr(art.defaultBranch || '') +
        '"><option value="">-- loading... --</option></select></div>';
      if (hasImages) {
        html +=
          '<div style="flex:1;min-width:160px;"><label style="font-size:0.85em;">Version / Image</label>' +
          '<select class="artifact-version">' +
          '<option value="">-- latest (default) --</option>';
        art.imageOptions.forEach(function (img) {
          html +=
            '<option value="' +
            escapeAttr(img) +
            '">' +
            escapeHtml(img) +
            '</option>';
        });
        html += '</select></div>';
      } else {
        html +=
          '<div style="flex:1;min-width:160px;"><label style="font-size:0.85em;">Version / Image</label><input type="text" class="artifact-version" placeholder="latest (leave empty for default)"></div>';
      }
      html += '</div></div>';
    });
    container.innerHTML = html;
  }

  function renderRunParameters(variables, inputs) {
    var container = document.getElementById('runParamsArea');
    if (
      (!variables || variables.length === 0) &&
      (!inputs || inputs.length === 0)
    ) {
      container.innerHTML = '';
      return;
    }
    var html = '';
    if (variables && variables.length > 0) {
      html +=
        '<div style="margin-top:4px;margin-bottom:8px;font-weight:600;font-size:0.9em;">Variables</div>';
      variables.forEach(function (v) {
        html += '<div class="field">';
        html +=
          '<label style="font-size:0.85em;">' + escapeHtml(v.name) + '</label>';
        html +=
          '<input type="text" class="run-variable" data-name="' +
          escapeHtml(v.name) +
          '" data-default-value="' +
          escapeHtml(v.value) +
          '" value="' +
          escapeHtml(v.value) +
          '" placeholder="' +
          escapeHtml(v.value || '') +
          '">';
        html += '</div>';
      });
    }
    if (inputs && inputs.length > 0) {
      html +=
        '<div style="margin-top:4px;margin-bottom:8px;font-weight:600;font-size:0.9em;">Parameters</div>';
      inputs.forEach(function (inp) {
        var paramType = (inp.type || 'string').toLowerCase();
        var hasOptions = inp.options && Object.keys(inp.options).length > 0;
        var optionKeys = hasOptions ? Object.keys(inp.options) : [];

        // Boolean → checkbox
        if (paramType === 'boolean') {
          var checked = inp.defaultValue === 'true' ? ' checked' : '';
          html += '<div class="field checkbox-field">';
          html +=
            '<label><input type="checkbox" class="run-template-param" data-name="' +
            escapeHtml(inp.name) +
            '" data-type="boolean" data-default-value="' +
            escapeHtml(inp.defaultValue) +
            '"' +
            checked +
            '> ' +
            escapeHtml(inp.label || inp.name) +
            '</label>';
          html += '</div>';
        }
        // Radio buttons: when type is 'radio', or when there are few options (<=5) and type is not 'pickList'
        else if (
          paramType === 'radio' ||
          (hasOptions && optionKeys.length <= 5 && paramType !== 'picklist')
        ) {
          html += '<div class="field">';
          html +=
            '<label style="font-size:0.85em;">' +
            escapeHtml(inp.label || inp.name) +
            (inp.required
              ? ' <span style="color:var(--vscode-errorForeground);">*</span>'
              : '') +
            '</label>';
          html += '<div class="radio-group">';
          optionKeys.forEach(function (key) {
            var checkedR = key === inp.defaultValue ? ' checked' : '';
            html +=
              '<label><input type="radio" name="param_' +
              escapeHtml(inp.name) +
              '" class="run-template-param-radio" data-name="' +
              escapeHtml(inp.name) +
              '" data-default-value="' +
              escapeHtml(inp.defaultValue) +
              '" value="' +
              escapeHtml(key) +
              '"' +
              checkedR +
              '> ' +
              escapeHtml(inp.options[key]) +
              '</label>';
          });
          html += '</div></div>';
        }
        // pickList / dropdown: many options or explicit pickList type
        else if (hasOptions) {
          html += '<div class="field">';
          html +=
            '<label style="font-size:0.85em;">' +
            escapeHtml(inp.label || inp.name) +
            (inp.required
              ? ' <span style="color:var(--vscode-errorForeground);">*</span>'
              : '') +
            '</label>';
          html +=
            '<select class="run-template-param" data-name="' +
            escapeHtml(inp.name) +
            '" data-default-value="' +
            escapeHtml(inp.defaultValue) +
            '">';
          optionKeys.forEach(function (key) {
            var selected = key === inp.defaultValue ? ' selected' : '';
            html +=
              '<option value="' +
              escapeHtml(key) +
              '"' +
              selected +
              '>' +
              escapeHtml(inp.options[key]) +
              '</option>';
          });
          html += '</select></div>';
        }
        // Text input (default)
        else {
          html += '<div class="field">';
          html +=
            '<label style="font-size:0.85em;">' +
            escapeHtml(inp.label || inp.name) +
            (inp.required
              ? ' <span style="color:var(--vscode-errorForeground);">*</span>'
              : '') +
            '</label>';
          html +=
            '<input type="text" class="run-template-param" data-name="' +
            escapeHtml(inp.name) +
            '" data-default-value="' +
            escapeHtml(inp.defaultValue) +
            '" value="' +
            escapeHtml(inp.defaultValue) +
            '" placeholder="' +
            escapeHtml(inp.defaultValue || '') +
            '">';
          html += '</div>';
        }
      });
    }
    container.innerHTML = html;
  }

  function escapeHtml(s) {
    if (!s) return '';
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Message handler
  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || !msg.command) return;
    dataReceived = true;

    try {
      switch (msg.command) {
        case 'configLoaded':
          containerImageTemplate = msg.containerImageTemplate || '';
          break;

        case 'navigateToBuild':
          if (msg.project) currentProject = msg.project;
          currentBuildId = msg.buildId;
          if (msg.definitionName) {
            document.getElementById('pipelineLabel').textContent =
              '\u2699\uFE0F ' + msg.definitionName;
            document.getElementById('pipelineLabel').classList.add('visible');
            document.getElementById('breadcrumbSep').classList.add('visible');
          }
          document.getElementById('loadingMsg').style.display = 'none';
          document.getElementById('pipelineArea').style.display = 'none';
          document.getElementById('buildDetailArea').style.display = 'block';
          document.getElementById('buildDetailTitle').textContent =
            (msg.definitionName || '') +
            ' \u2014 Run #' +
            (msg.buildNumber || '');
          document.getElementById('buildsBody').innerHTML = '';
          var tlArea = document.getElementById('timelineArea');
          tlArea.textContent = '';
          var loadDiv = document.createElement('div');
          loadDiv.className = 'loading';
          loadDiv.textContent = 'Loading stages...';
          tlArea.appendChild(loadDiv);
          break;

        case 'pipelinesLoaded':
          allPipelines = msg.pipelines || [];
          if (msg.project) currentProject = msg.project;
          if (msg.favorites) {
            favorites = new Set(msg.favorites);
          }
          document.getElementById('loadingMsg').style.display = 'none';
          if (!currentBuildId) {
            document.getElementById('pipelineArea').style.display = 'block';
            document.getElementById('buildDetailArea').style.display = 'none';
            document
              .getElementById('pipelineLabel')
              .classList.remove('visible');
            document
              .getElementById('breadcrumbSep')
              .classList.remove('visible');
          }
          renderPipelines();
          break;

        case 'buildsLoaded':
          renderBuilds(msg.builds);
          break;

        case 'timelineLoaded':
          renderTimeline(msg.stages);
          break;

        case 'buildChangesLoaded':
          renderBuildChanges(msg.changes);
          break;

        case 'buildQueued':
          if (currentDefinitionId !== null) {
            vscode.postMessage({
              command: 'loadBuilds',
              definitionId: currentDefinitionId,
              project: currentProject,
            });
          }
          break;

        case 'favoritesUpdated':
          favorites = new Set(msg.favorites || []);
          renderPipelines();
          break;

        case 'branchesLoaded':
          var sel = document.getElementById('runBranch');
          if (sel) {
            sel.innerHTML = '<option value="">-- default --</option>';
            (msg.branches || []).forEach(function (b) {
              var opt = document.createElement('option');
              opt.value = b;
              opt.textContent = b;
              sel.appendChild(opt);
            });
          }
          // Also populate release artifact branch selects
          var artBranches = document.querySelectorAll('.artifact-branch');
          var currentBranch = msg.currentBranch || '';
          artBranches.forEach(function (branchSel) {
            var defaultBranch = branchSel.dataset.defaultBranch || '';
            var preselect = currentBranch || defaultBranch;
            branchSel.innerHTML = '<option value="">-- default --</option>';
            (msg.branches || []).forEach(function (b) {
              var opt = document.createElement('option');
              opt.value = b;
              opt.textContent = b;
              if (b === preselect) {
                opt.selected = true;
              }
              branchSel.appendChild(opt);
            });
          });
          break;

        case 'pipelineParametersLoaded':
          renderRunParameters(msg.variables || [], msg.inputs || []);
          break;

        case 'releaseDefinitionsLoaded':
          releaseDefinitions = msg.definitions || [];
          renderReleaseDefinitions(releaseDefinitions);
          break;

        case 'releaseDefinitionDetailLoaded':
          renderReleaseArtifactFields(msg.artifacts || []);
          break;

        case 'releasesLoaded':
          renderReleases(msg.releases);
          break;

        case 'releaseCreated':
          if (currentReleaseDefId !== null) {
            vscode.postMessage({
              command: 'loadReleases',
              definitionId: currentReleaseDefId,
              project: currentProject,
            });
          }
          break;

        case 'deployOptionsLoaded':
          var defSelect = document.getElementById('deployDefSelect');
          var defs = msg.releaseDefinitions || [];
          if (defs.length === 0) {
            defSelect.innerHTML =
              '<option value="">No release definitions found for this pipeline</option>';
            defSelect.disabled = true;
          } else {
            defSelect.innerHTML =
              '<option value="">-- select release definition --</option>';
            defs.forEach(function (d) {
              var opt = document.createElement('option');
              opt.value = d.id;
              opt.textContent = d.name;
              defSelect.appendChild(opt);
            });
            defSelect.disabled = false;
            if (defs.length === 1) {
              defSelect.value = String(defs[0].id);
            }
          }
          break;

        case 'autoDeployOptionsLoaded':
          autoDeployReleaseDefs = msg.releaseDefinitions || [];
          var adDefSel = document.getElementById('autoDeployDefSelect');
          if (adDefSel) {
            adDefSel.innerHTML = '';
            if (autoDeployReleaseDefs.length === 0) {
              adDefSel.innerHTML =
                '<option value="">No release definitions found</option>';
              adDefSel.disabled = true;
            } else {
              autoDeployReleaseDefs.forEach(function (d) {
                var opt = document.createElement('option');
                opt.value = d.id;
                opt.textContent = d.name;
                adDefSel.appendChild(opt);
              });
              adDefSel.disabled = false;
              // Auto-select first and load its environments
              autoDeploySelectedDefId = autoDeployReleaseDefs[0].id;
              adDefSel.value = String(autoDeploySelectedDefId);
              vscode.postMessage({
                command: 'loadAutoDeployEnvs',
                releaseDefinitionId: autoDeploySelectedDefId,
                project: currentProject,
              });
            }
          }
          break;

        case 'autoDeployEnvsLoaded':
          autoDeployEnvs = msg.environments || [];
          var adEnvSel = document.getElementById('autoDeployEnvSelect');
          if (adEnvSel) {
            adEnvSel.innerHTML = '<option value="">All environments</option>';
            autoDeployEnvs.forEach(function (env) {
              var opt = document.createElement('option');
              opt.value = env.name;
              opt.textContent = env.name;
              adEnvSel.appendChild(opt);
            });
            autoDeploySelectedEnv = null;
          }
          break;

        case 'autoDeployResult':
          if (msg.status === 'noDefinitions') {
            showError(
              'Auto-deploy: no release definitions found for this pipeline.',
            );
          } else if (
            msg.status === 'multipleDefinitions' &&
            currentBuildForTimeline
          ) {
            // Multiple release definitions — open the deploy modal for user to pick
            deployBuildData = currentBuildForTimeline;
            var modal = document.getElementById('deployModal');
            document.getElementById('deployBuildLabel').textContent =
              '#' +
              (currentBuildForTimeline.buildNumber || '') +
              ' \u00B7 ' +
              (currentBuildForTimeline.sourceBranch || '');
            var defSelect2 = document.getElementById('deployDefSelect');
            defSelect2.innerHTML =
              '<option value="">-- select release definition --</option>';
            (msg.releaseDefinitions || []).forEach(function (d) {
              var opt = document.createElement('option');
              opt.value = d.id;
              opt.textContent = d.name;
              defSelect2.appendChild(opt);
            });
            defSelect2.disabled = false;
            modal.classList.add('visible');
          }
          // 'deployed' status — releaseCreated message will follow from backend
          break;

        case 'error':
          showError(msg.message);
          break;
      }
    } catch (e) {
      showError('Rendering error: ' + e.message);
    }
  });

  // Tell the backend we are ready to receive data
  vscode.postMessage({ command: 'ready' });

  // Safety: if no data arrives within 15s, show a helpful error
  setTimeout(function () {
    if (!dataReceived) {
      var lm = document.getElementById('loadingMsg');
      if (lm && lm.style.display !== 'none') {
        showError(
          'No response from backend after 15 seconds. Possible causes: invalid PAT, missing permissions, or network issues. Try reloading the window (Ctrl+Shift+P > Reload Window).',
        );
      }
    }
  }, 15000);
})();
