# Security Policy

## Supported Versions

Only the latest minor release of `@cbs-consulting/stack-sentinel` receives
security fixes. Upgrade to it before you report a problem.

| Version | Supported |
| ------- | --------- |
| 0.3.x   | Yes       |
| < 0.3   | No        |

## Reporting a Vulnerability

Do not open a public issue for a security problem. Report it privately in one
of these ways:

- Through [GitHub private vulnerability reporting](https://github.com/cbs-consulting/stack-sentinel/security/advisories/new).
- By email to [cp_opensource@cbs-consulting.de](mailto:cp_opensource@cbs-consulting.de),
  with [administrator@cbs-consulting.de](mailto:administrator@cbs-consulting.de)
  in copy.

Describe the problem, the affected version and the steps to reproduce it. If
you know of a fix or a workaround, add it as well. Do not include real webhook
or heartbeat URLs.

We confirm that we received your report within five working days and keep you
informed while we work on a fix. Once the fix is released we publish a
security advisory and credit you, unless you would rather stay anonymous.

## Scope

This policy covers stack-sentinel itself, including the pipeline examples in
`examples/`, for instance a way to leak a webhook URL or to make the tool run
code from a scanned project. Vulnerabilities that stack-sentinel finds in a
scanned project are not reports for this policy; they belong with that project
or with the affected package. Wrong data in the feeds it reads, such as SAP's
UI5 version overview or the npm audit service, belongs with their publishers.
