# Contributing

Thank you for helping to improve `@cbs-consulting/stack-sentinel`. This guide
explains how to propose a change. The [Contributing](README.md#contributing)
section of the README explains how to add a check and how the tests work, and
[docs/DECISIONS.md](docs/DECISIONS.md) explains why the tool works the way it
does.

By taking part in this project you agree to follow our
[Code of Conduct](CODE_OF_CONDUCT.md). To report a security problem, follow the
[Security Policy](SECURITY.md) instead of opening an issue.

## Reporting bugs and requesting features

Search the [existing issues](https://github.com/cbs-consulting/stack-sentinel/issues)
first. If nothing matches, open a new issue with the bug report or feature
request form. For a larger change, such as a new check, open an issue before
you start so we can agree on the approach.

## Making a change

1. Fork the repository and create a branch from `main`.
2. There is nothing to install; you need Node.js 22 or newer. Optionally enable
   the git hook that runs the tests before each push:

   ```sh
   npm run hooks
   ```

3. Make your change and add or update the tests for it. The tool has no
   dependencies; keep it that way unless the issue agreed otherwise.
4. Check that everything passes:

   ```sh
   npm test
   ```

5. Add a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md) that describes
   the change for users. A pull request that changes nothing a user notices,
   such as a CI or documentation fix, gets the label "no changelog" instead.
6. Open a pull request against `main` and fill in the template.

Pull requests are merged through a merge queue. Once the checks pass and the
pull request is approved, choose **Merge when ready**: GitHub tests it on top
of `main` and the pull requests queued ahead of it, and merges it when the
checks pass there too. You don't have to update your branch with `main`
first.

Dependabot's minor and patch updates are approved and queued automatically
once their checks pass; major updates wait for a maintainer.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/), for example
`feat: add cap-version check` or `fix(npm-audit): ignore dev dependencies`.
Keep each pull request to one topic; it is squashed into a single commit when
merged.

## License

By contributing you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE), the license of this project.
