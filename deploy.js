#!/usr/bin/env node
// deploy.js — sync output/ to S3
// Usage: node deploy.js   or   npm run deploy

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

const outputDir = path.join(__dirname, 'output');
if (!fs.existsSync(outputDir)) {
  console.error('Error: output/ not found. Run npm run generate first.');
  process.exit(1);
}

console.log(`\nDeploying output/ → s3://${bucket}  (region: ${region})\n`);

execSync(
  `aws s3 sync "${outputDir}" s3://${bucket} --delete --region ${region} --cache-control "max-age=300,public"`,
  { stdio: 'inherit' }
);

const websiteUrl = `http://${bucket}.s3-website-${region}.amazonaws.com`;
console.log(`\nDone!  ${websiteUrl}\n`);
