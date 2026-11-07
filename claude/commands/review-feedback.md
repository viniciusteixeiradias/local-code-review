---
description: Pull local code review comments from lcr and address them
allowed-tools: Bash(lcr feedback:*), Bash(lcr resolve:*), Bash(lcr reply:*), Bash(lcr list:*)
---

Run `lcr feedback` to get the review comments I left in the local review UI, then address each one.

- After fixing a comment, run `lcr resolve <id> -m "<one line on what you changed>"`.
- If you disagree or need clarification, don't change the code for it; run `lcr reply <id> -m "<your reasoning or question>"` instead.
- If `lcr feedback` says there's nothing pending, tell me and stop.
