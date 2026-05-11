# Extension Lifecycle Recipes

## Inspect Current State

```bash
pm package explore --project
pm package manage --detail summary
pm package doctor --detail deep
```

## Install and Activate

```bash
pm install <target> --project
pm package activate <target> --project
pm package doctor --detail summary
```

## Adopt Existing Extensions

```bash
pm package adopt <name> --project
pm package adopt-all --project
pm package manage --detail summary
```

## Deactivate / Uninstall

```bash
pm package deactivate <target> --project
pm package uninstall <target> --project
pm package doctor --detail deep
```

## Contract Checks

```bash
pm contracts --runtime-only --availability-only
pm contracts --command package --flags-only
```
