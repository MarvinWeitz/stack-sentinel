import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectPipeline } from '../src/pipeline.js';

test('detects GitHub Actions runs', () => {
  assert.deepEqual(detectPipeline({
    GITHUB_ACTIONS: 'true', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'customer/orders', GITHUB_RUN_ID: '123',
  }), {
    platform: 'github',
    repositoryUrl: 'https://github.com/customer/orders',
    runUrl: 'https://github.com/customer/orders/actions/runs/123',
  });
});

test('detects Azure DevOps runs, and cleans up the repository address', () => {
  assert.deepEqual(detectPipeline({
    TF_BUILD: 'True',
    SYSTEM_COLLECTIONURI: 'https://dev.azure.com/customer-org/',
    SYSTEM_TEAMPROJECT: 'Order Management',
    BUILD_BUILDID: '4711',
    BUILD_REPOSITORY_URI: 'https://customer-org@dev.azure.com/customer-org/Order%20Management/_git/orders',
  }), {
    platform: 'azure-devops',
    runUrl: 'https://dev.azure.com/customer-org/Order%20Management/_build/results?buildId=4711',
    repositoryUrl: 'https://dev.azure.com/customer-org/Order%20Management/_git/orders',
  });
  // older organization addresses and missing trailing slashes work too
  assert.equal(detectPipeline({ TF_BUILD: 'True', SYSTEM_COLLECTIONURI: 'https://customer.visualstudio.com', SYSTEM_TEAMPROJECT: 'P', BUILD_BUILDID: '1' }).runUrl,
    'https://customer.visualstudio.com/P/_build/results?buildId=1');
});

test('outside a known pipeline nothing is detected', () => {
  assert.deepEqual(detectPipeline({}), {});
  assert.deepEqual(detectPipeline({ GITHUB_REPOSITORY: 'x/y' }), {}); // not inside GitHub Actions
});
