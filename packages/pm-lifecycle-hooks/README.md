# pm-lifecycle-hooks

First-party package that demonstrates lifecycle hook registration through the
public pm SDK.

This package is intentionally default-inert. Its `afterCommand` hook returns
without producing output, writing files, or changing command behavior. Package
authors can copy this shape when they need low-risk observation hooks.

## Capabilities

- `hooks`

## Install

```bash
pm install lifecycle-hooks --project
```

## Verify

```bash
pm package doctor --project --detail deep --json
pm contracts --runtime-only --availability-only --json
```
