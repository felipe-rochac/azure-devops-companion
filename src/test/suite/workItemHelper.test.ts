import * as assert from 'assert';
import { extractWorkItemIdsFromBranch, extractWorkItemIdsFromText, inferLinkedWorkItemIds, suggestWorkItemTitle } from '../../utils/workItemHelper';

suite('WorkItemHelper Tests', () => {
  test('extracts explicit work item ids from text', () => {
    assert.deepStrictEqual(extractWorkItemIdsFromText('Fixes AB#123 and relates to #456'), [123, 456]);
  });

  test('extracts work item ids from branch names', () => {
    assert.deepStrictEqual(extractWorkItemIdsFromBranch('feature/12345-add-linked-work-items'), [12345]);
    assert.deepStrictEqual(extractWorkItemIdsFromBranch('bugfix/AB#6789-review-flow'), [6789]);
  });

  test('infers linked ids across branch title and description', () => {
    assert.deepStrictEqual(
      inferLinkedWorkItemIds({
        branchName: 'feature/12345-add-my-work',
        title: 'AB#987 improve PR overview',
        description: 'Follow-up on #12345 and #7777',
      }),
      [12345, 987, 7777]
    );
  });

  test('suggests a readable title from branch name', () => {
    assert.strictEqual(suggestWorkItemTitle('feature/12345-add-my-work-items'), 'Add My Work Items');
  });
});
