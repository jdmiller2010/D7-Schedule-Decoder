#!/usr/bin/env node
// setup-s3.js — one-time S3 bucket setup for public static website hosting
// Run once before deploying: node setup-s3.js

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const { loadEnv } = require('./config');

const env    = loadEnv();
const bucket = env.S3_BUCKET  || process.env.S3_BUCKET;
const region = env.AWS_REGION || process.env.AWS_REGION || 'us-east-1';

if (!bucket) {
  console.error('Error: S3_BUCKET not set. Add it to your .env file.');
  process.exit(1);
}

function run(label, cmd) {
  process.stdout.write(`  ${label}... `);
  try {
    execSync(cmd, { stdio: 'pipe' });
    console.log('done');
  } catch (e) {
    const msg = (e.stderr || e.stdout || e.message || '').toString().trim();
    // BucketAlreadyOwnedByYou is not an error
    if (msg.includes('BucketAlreadyOwnedByYou') || msg.includes('already exists')) {
      console.log('already exists');
    } else {
      console.log('FAILED');
      console.error('    ' + msg.split('\n')[0]);
      throw e;
    }
  }
}

console.log(`\nSetting up s3://${bucket}  (region: ${region})\n`);

// 1. Create bucket
run(
  'Creating bucket',
  region === 'us-east-1'
    ? `aws s3api create-bucket --bucket ${bucket} --region ${region}`
    : `aws s3api create-bucket --bucket ${bucket} --region ${region} --create-bucket-configuration LocationConstraint=${region}`
);

// 2. Disable Block Public Access
run(
  'Disabling block-public-access',
  `aws s3api put-public-access-block --bucket ${bucket} --region ${region} ` +
  `--public-access-block-configuration BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false`
);

// 3. Apply public-read bucket policy (write to temp file to avoid shell-quoting issues)
const policy = JSON.stringify({
  Version: '2012-10-17',
  Statement: [{
    Effect: 'Allow',
    Principal: '*',
    Action: 's3:GetObject',
    Resource: `arn:aws:s3:::${bucket}/*`,
  }],
});
const tmpFile = path.join(__dirname, '.tmp-bucket-policy.json');
fs.writeFileSync(tmpFile, policy);
try {
  run(
    'Setting public-read bucket policy',
    `aws s3api put-bucket-policy --bucket ${bucket} --region ${region} --policy file://${tmpFile}`
  );
} finally {
  fs.unlinkSync(tmpFile);
}

// 4. Enable static website hosting
run(
  'Enabling static website hosting',
  `aws s3 website s3://${bucket} --index-document index.html --error-document index.html`
);

const websiteUrl = `http://${bucket}.s3-website-${region}.amazonaws.com`;
console.log(`\nBucket ready.`);
console.log(`  Website URL : ${websiteUrl}`);
console.log(`  Next        : npm run deploy\n`);
