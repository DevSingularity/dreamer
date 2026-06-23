#!/bin/bash

export GIT_REPOSITORY_URL="$GIT_REPOSITORY_URL"
export BRANCH="${BRANCH:-main}"

git clone --branch "$BRANCH" --single-branch "$GIT_REPOSITORY_URL" /home/app/output

exec node script.js