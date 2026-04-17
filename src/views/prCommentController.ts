import * as vscode from 'vscode';
import { AzureDevOpsApi } from '../api/azureDevOpsApi';
import { GitPullRequest } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { formatCommentContent } from '../utils/commentFormatter';

class PRComment implements vscode.Comment {
  body: string | vscode.MarkdownString;
  mode: vscode.CommentMode;
  author: vscode.CommentAuthorInformation;

  constructor(
    content: string,
    authorName: string,
    public readonly adoCommentId?: number
  ) {
    this.body = new vscode.MarkdownString(content);
    this.mode = vscode.CommentMode.Preview;
    this.author = { name: authorName };
  }
}

interface ThreadMeta {
  adoThreadId: number;
  filePath: string;
}

export class PRCommentController {
  private controller: vscode.CommentController;
  private vsThreads = new Map<number, vscode.CommentThread>();
  private threadMeta = new WeakMap<vscode.CommentThread, ThreadMeta>();
  private currentPR: GitPullRequest | undefined;
  private loadedFiles = new Set<string>();
  private disposables: vscode.Disposable[] = [];

  constructor(private api: AzureDevOpsApi) {
    this.controller = vscode.comments.createCommentController(
      'azureDevOpsPR.comments',
      'Azure DevOps PR Comments'
    );

    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document: vscode.TextDocument) => {
        if (document.uri.scheme === 'ado-pr' && this.currentPR) {
          return [new vscode.Range(0, 0, document.lineCount - 1, 0)];
        }
        return [];
      },
    };

    this.controller.options = {
      prompt: 'Add a review comment...',
      placeHolder: 'Type your comment. Use ```suggestion for code suggestions.',
    };

    // Auto-load threads when a PR file opens
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => {
        if (doc.uri.scheme === 'ado-pr' && this.currentPR) {
          this.loadThreadsForDocument(doc);
        }
      })
    );
  }

  setPR(pr: GitPullRequest | undefined) {
    this.currentPR = pr;
    this.clearThreads();
  }

  getController(): vscode.CommentController {
    return this.controller;
  }

  async loadThreadsForDocument(document: vscode.TextDocument) {
    if (!this.currentPR || document.uri.scheme !== 'ado-pr') {
      return;
    }

    const repoId = this.currentPR.repository?.id;
    const prId = this.currentPR.pullRequestId;
    if (!repoId || !prId) {
      return;
    }

    const filePath = document.uri.path;
    if (this.loadedFiles.has(filePath)) {
      return;
    }
    this.loadedFiles.add(filePath);

    try {
      const threads = await this.api.getPRThreads(repoId, prId);

      for (const thread of threads) {
        if (!thread.threadContext?.filePath) {
          continue;
        }
        if (thread.threadContext.filePath !== filePath) {
          continue;
        }

        const line =
          thread.threadContext.rightFileEnd?.line ??
          thread.threadContext.rightFileStart?.line ??
          thread.threadContext.leftFileEnd?.line ??
          thread.threadContext.leftFileStart?.line;
        if (!line) {
          continue;
        }

        const vsLine = Math.max(0, line - 1);
        const range = new vscode.Range(vsLine, 0, vsLine, 0);

        const comments = (thread.comments ?? [])
          .filter((c: any) => c.commentType !== 0)
          .map(
            (c: any) =>
              new PRComment(
                formatCommentContent(c.content ?? ''),
                c.author?.displayName ?? 'Unknown',
                c.id
              )
          );

        if (comments.length === 0) {
          continue;
        }

        const vsThread = this.controller.createCommentThread(
          document.uri,
          range,
          comments
        );
        vsThread.canReply = true;
        vsThread.label = this.threadStatusLabel(thread.status);
        vsThread.contextValue =
          thread.status === 2 || thread.status === 3 || thread.status === 4
            ? 'resolved'
            : 'active';

        if (thread.id) {
          this.vsThreads.set(thread.id, vsThread);
          this.threadMeta.set(vsThread, {
            adoThreadId: thread.id,
            filePath,
          });
        }
      }
    } catch (err) {
      console.error('Failed to load PR threads:', err);
    }
  }

  async createThread(reply: vscode.CommentReply) {
    if (!this.currentPR) {
      return;
    }

    const repoId = this.currentPR.repository?.id;
    const prId = this.currentPR.pullRequestId;
    if (!repoId || !prId) {
      return;
    }

    const filePath = reply.thread.uri.path;
    const line = (reply.thread.range?.start.line ?? 0) + 1;

    try {
      const adoThread = await this.api.createInlineThread(
        repoId,
        prId,
        reply.text,
        filePath,
        line
      );

      if (adoThread.id) {
        const comments = (adoThread.comments ?? [])
          .filter((c: any) => c.commentType !== 0)
          .map(
            (c: any) =>
              new PRComment(
                formatCommentContent(c.content ?? ''),
                c.author?.displayName ?? 'You',
                c.id
              )
          );

        reply.thread.comments = comments;
        reply.thread.canReply = true;
        reply.thread.contextValue = 'active';
        reply.thread.label = '💬 Active';

        this.vsThreads.set(adoThread.id, reply.thread);
        this.threadMeta.set(reply.thread, {
          adoThreadId: adoThread.id,
          filePath,
        });
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(
        `Failed to create comment: ${err?.message ?? err}`
      );
    }
  }

  async replyToThread(reply: vscode.CommentReply) {
    if (!this.currentPR) {
      return;
    }

    const repoId = this.currentPR.repository?.id;
    const prId = this.currentPR.pullRequestId;
    if (!repoId || !prId) {
      return;
    }

    const meta = this.threadMeta.get(reply.thread);
    if (!meta) {
      await this.createThread(reply);
      return;
    }

    try {
      const comment = await this.api.replyToThread(
        repoId,
        prId,
        meta.adoThreadId,
        reply.text
      );

      const newComment = new PRComment(reply.text, 'You', comment.id);
      reply.thread.comments = [...reply.thread.comments, newComment];
    } catch (err: any) {
      vscode.window.showErrorMessage(
        `Failed to reply: ${err?.message ?? err}`
      );
    }
  }

  async resolveThread(thread: vscode.CommentThread) {
    if (!this.currentPR) {
      return;
    }

    const repoId = this.currentPR.repository?.id;
    const prId = this.currentPR.pullRequestId;
    if (!repoId || !prId) {
      return;
    }

    const meta = this.threadMeta.get(thread);
    if (!meta) {
      return;
    }

    try {
      await this.api.updateThreadStatus(repoId, prId, meta.adoThreadId, 2);
      thread.label = '✅ Resolved';
      thread.contextValue = 'resolved';
    } catch (err: any) {
      vscode.window.showErrorMessage(
        `Failed to resolve thread: ${err?.message ?? err}`
      );
    }
  }

  async reactivateThread(thread: vscode.CommentThread) {
    if (!this.currentPR) {
      return;
    }

    const repoId = this.currentPR.repository?.id;
    const prId = this.currentPR.pullRequestId;
    if (!repoId || !prId) {
      return;
    }

    const meta = this.threadMeta.get(thread);
    if (!meta) {
      return;
    }

    try {
      await this.api.updateThreadStatus(repoId, prId, meta.adoThreadId, 1);
      thread.label = '💬 Active';
      thread.contextValue = 'active';
    } catch (err: any) {
      vscode.window.showErrorMessage(
        `Failed to reactivate thread: ${err?.message ?? err}`
      );
    }
  }

  private threadStatusLabel(status?: number): string {
    switch (status) {
      case 1:
        return '💬 Active';
      case 2:
        return '✅ Fixed';
      case 3:
        return "✅ Won't Fix";
      case 4:
        return '✅ Closed';
      case 5:
        return '❓ By Design';
      case 6:
        return '⏳ Pending';
      default:
        return '';
    }
  }

  private clearThreads() {
    for (const thread of this.vsThreads.values()) {
      thread.dispose();
    }
    this.vsThreads.clear();
    this.loadedFiles.clear();
  }

  dispose() {
    this.clearThreads();
    this.controller.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
