# Contributing to Alert Rollup

RezaLabs maintains high standards. This document defines them.

## Pull Requests Are Not Accepted

This project is maintained by a single developer using heavy AI assistance. Every line of code is generated, reviewed, and curated through an iterative prompting workflow. Pull requests are not accepted.

**Why:** The AI-assisted workflow produces code that is internally consistent in style, structure, and idiom. External contributions, even well-intentioned ones, introduce a maintenance burden: review, style alignment, test integration, and documentation updates that do not scale for a solo maintainer. The output standard is higher when one person owns every line.

## What Is Accepted

### Bug Reports

If you find a bug, open an issue. Include:

- Exact steps to reproduce.
- Expected behaviour vs actual behaviour.
- Environment details: OS, Node.js version, dependency versions.

I fix bugs quickly. A good bug report with a reproduction case gets a fix within days.

### Feature Requests

Feature requests are welcome as issues. Describe:

- The problem you want to solve.
- Why the existing API cannot solve it.
- What the ideal solution looks like.

Feature requests are evaluated against the project's core principles. If a request aligns, I implement it. If not, I explain why.

### Documentation Issues

Errors, omissions, or unclear sections in documentation are bugs. Report them with a reference to the specific file and section.

## Standards (Self-Imposed)

- **Code quality** is non-negotiable. Every function is touched multiple times before release.
- **Tests are mandatory.** No feature ships without tests. No bug fix ships without a regression test.
- **Commits follow Conventional Commits.** Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`.
- **Changelog is updated** before every release following Keep a Changelog.

## Attribution

All original code is licensed under the MIT License. Maintained by [RezaLabs](https://rezalabs.com).
