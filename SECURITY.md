# Security policy

## Reporting a vulnerability

Please do not report security vulnerabilities through public GitHub issues, discussions or pull requests.

Send them confidentially by email to [info@sb-techworks.de](mailto:info@sb-techworks.de?subject=Security%20vulnerability) with the subject "Security vulnerability", in English or German. How to report, what to include, the scope and the rules for testing are described on [limenia.eu/sicherheit](https://limenia.eu/sicherheit/) (English: [limenia.eu/en/security](https://limenia.eu/en/security/)). The machine-readable contact is [limenia.eu/.well-known/security.txt](https://limenia.eu/.well-known/security.txt).

Please include:

- the affected example and file, or the commit you looked at
- what the vulnerability is and what someone could do with it
- the steps to reproduce it

Only test with your own accounts and data, and never against data of other Limenia customers or their users. We answer within 5 working days. There is no bug bounty programme.

## Scope and supported versions

This repository holds example backends that you copy into your own project. Security fixes go into the `main` branch only. If you based your backend on an example, compare your copy with the latest version from time to time; changes that affect security are described in the commit messages.

Vulnerabilities in the Limenia service itself (dashboard and API) or in the Flutter packages can be reported the same way.
