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
    var showing = filtered.slice(0, displayCount);
    document.getElementById('pipelineCount').textContent =
      'Showing ' + showing.length + ' of ' + filtered.length + ' pipelines';

    // Build cards using DOM to avoid any innerHTML quote issues
    grid.innerHTML = '';
    showing.forEach(function (p) {
      var card = document.createElement('div');
      card.className = 'pipeline-card';

      var latest = p.latestBuild;
      var badgeHtml = latest
        ? statusBadge(latest.status, latest.result)
        : '<span class="build-badge none">No runs</span>';

      var headerDiv = document.createElement('div');
      headerDiv.className = 'pipeline-card-header';
      var nameDiv = document.createElement('div');
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
      grid.appendChild(card);
    });

    if (filtered.length > displayCount) {
      var more = document.createElement('div');
      more.className = 'load-more-bar';
      var moreBtn = document.createElement('button');
      moreBtn.className = 'btn-secondary';
      moreBtn.textContent =
        'Show more (' + (filtered.length - displayCount) + ' remaining)';
      moreBtn.onclick = function () {
        window.loadMore();
      };
      more.appendChild(moreBtn);
      grid.appendChild(more);
    }
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
    loadingCell.colSpan = 6;
    loadingCell.className = 'loading';
    loadingCell.textContent = 'Loading...';
    loadingRow.appendChild(loadingCell);
    document.getElementById('buildsBody').appendChild(loadingRow);
    document.getElementById('timelineArea').innerHTML = '';
    vscode.postMessage({
      command: 'loadBuilds',
      definitionId: definitionId,
      project: currentProject,
    });
  };

  window.backToPipelines = function () {
    currentDefinitionId = null;
    currentBuildId = null;
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

  window.viewTimeline = function (buildId, buildNumber) {
    currentBuildId = buildId;
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
  };

  window.toggleCollapse = function (el) {
    var c = el.nextElementSibling;
    var ch = el.querySelector('.chevron');
    if (c) c.classList.toggle('hidden');
    if (ch) ch.classList.toggle('collapsed');
  };

  window.openRunModal = function (definitionId, name) {
    document.getElementById('runPipelineName').value = name;
    document.getElementById('runBranch').value = '';
    document.getElementById('runModal').classList.add('visible');
    document.getElementById('runModal').dataset.definitionId =
      String(definitionId);
  };

  window.closeRunModal = function () {
    document.getElementById('runModal').classList.remove('visible');
  };

  window.submitRun = function () {
    var defId = parseInt(
      document.getElementById('runModal').dataset.definitionId,
    );
    var branch = document.getElementById('runBranch').value.trim();
    vscode.postMessage({
      command: 'queueBuild',
      definitionId: defId,
      branch: branch,
      project: currentProject,
    });
    window.closeRunModal();
  };

  window.openUrl = function (url) {
    vscode.postMessage({ command: 'openInBrowser', url: url });
  };

  function renderBuilds(builds) {
    var tbody = document.getElementById('buildsBody');
    tbody.innerHTML = '';
    if (!builds || builds.length === 0) {
      var emptyRow = document.createElement('tr');
      var emptyCell = document.createElement('td');
      emptyCell.colSpan = 6;
      emptyCell.className = 'empty';
      emptyCell.textContent = 'No runs found.';
      emptyRow.appendChild(emptyCell);
      tbody.appendChild(emptyRow);
      return;
    }
    builds.forEach(function (b) {
      var tr = document.createElement('tr');
      tr.onclick = (function (id, num) {
        return function () {
          window.viewTimeline(id, num);
        };
      })(b.id, b.buildNumber);

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

      var tdDuration = document.createElement('td');
      tdDuration.textContent = duration(b.startTime, b.finishTime);
      tr.appendChild(tdDuration);

      var tdActions = document.createElement('td');
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

  // Message handler
  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || !msg.command) return;
    dataReceived = true;

    try {
      switch (msg.command) {
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

        case 'buildQueued':
          if (currentDefinitionId !== null) {
            vscode.postMessage({
              command: 'loadBuilds',
              definitionId: currentDefinitionId,
              project: currentProject,
            });
          }
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
