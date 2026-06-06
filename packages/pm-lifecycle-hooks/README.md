# pm-lifecycle-hooks

First-party package that demonstrates lifecycle hook registration through the
public pm SDK.

This package is intentionally default-inert. Its `afterCommand` hook returns
without producing output, writing files, or changing command behavior. Package
authors can copy this shape when they need low-risk observation hooks.

Transition-aware packages can inspect `afterCommand`'s optional `affected`
entries for item mutations. Each entry includes the item id, operation,
previous/current status, changed fields, and compact front matter snapshots.

Copy this pattern when a package needs command-level notifications without
parsing command results or reading item files:

```ts
api.hooks.afterCommand((event) => {
  const transitions = event.affected?.filter(
    (item) => item.previous_status !== item.status && item.status !== undefined,
  );

  if (!transitions?.length) {
    return;
  }

  // Notify, enqueue, or cache based on item.id, item.previous_status,
  // item.status, item.changed_fields, and item.current.
});
```

Use `afterCommand` for command-level context such as notifications. Use
`onWrite` when a package needs file-level sync or audit behavior.

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
