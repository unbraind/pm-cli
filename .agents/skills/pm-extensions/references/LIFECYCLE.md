# Extension Lifecycle Recipes

## Inspect Current State

```bash
pm extension explore --project
pm extension manage --detail summary
pm extension doctor --detail deep
```

## Install and Activate

```bash
pm extension install <target> --project
pm extension activate <target> --project
pm extension doctor --detail summary
```

## Adopt Existing Extensions

```bash
pm extension adopt <name> --project
pm extension adopt-all --project
pm extension manage --detail summary
```

## Deactivate / Uninstall

```bash
pm extension deactivate <target> --project
pm extension uninstall <target> --project
pm extension doctor --detail deep
```

## Contract Checks

```bash
pm contracts --runtime-only --availability-only
pm contracts --command extension --flags-only
```
