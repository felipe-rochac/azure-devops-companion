export interface WorkItemInferenceInput {
  branchName?: string;
  title?: string;
  description?: string;
}

export function extractWorkItemIdsFromText(text: string | undefined): number[] {
  if (!text) {
    return [];
  }

  const ids: number[] = [];
  const explicitMatches = text.matchAll(/(?:AB#|#)(\d{2,})\b/gi);
  for (const match of explicitMatches) {
    ids.push(Number(match[1]));
  }
  return uniqueIds(ids);
}

export function extractWorkItemIdsFromBranch(branchName: string | undefined): number[] {
  if (!branchName) {
    return [];
  }

  const ids = extractWorkItemIdsFromText(branchName);
  const prefixMatch = branchName.match(/^(?:[^/]+\/)?(\d{2,})(?=[-_./]|$)/);
  if (prefixMatch) {
    ids.push(Number(prefixMatch[1]));
  }

  const segmentMatches = branchName.matchAll(/(?:^|[\/])(?:feature|bugfix|hotfix|task|story|userstory)?[-_/]?(\d{2,})(?=[-_./]|$)/gi);
  for (const match of segmentMatches) {
    ids.push(Number(match[1]));
  }

  return uniqueIds(ids);
}

export function inferLinkedWorkItemIds(input: WorkItemInferenceInput): number[] {
  return uniqueIds([
    ...extractWorkItemIdsFromBranch(input.branchName),
    ...extractWorkItemIdsFromText(input.title),
    ...extractWorkItemIdsFromText(input.description),
  ]);
}

export function suggestWorkItemTitle(branchName: string | undefined): string {
  if (!branchName) {
    return '';
  }

  const normalized = branchName
    .replace(/^refs\/heads\//, '')
    .replace(/^AB#\d+[-_/]*/i, '')
    .replace(/^(?:[^/]+\/)?\d+[-_/]*/i, '')
    .split('/')
    .pop() ?? branchName;

  return normalized
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function uniqueIds(ids: number[]): number[] {
  return [...new Set(ids.filter((id) => Number.isFinite(id) && id > 0))];
}
