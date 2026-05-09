# Extension Troubleshooting

## Common Diagnostic Sequence

1. `pm extension explore --project`
2. `pm extension manage --detail summary`
3. `pm extension doctor --detail deep --trace`
4. `pm contracts --runtime-only --availability-only`

## Symptoms and Checks

- **Command not visible**
  - Confirm extension is managed and active.
  - Confirm capability includes `commands`.
  - Check `pm contracts` action availability.

- **Schema mismatch**
  - Confirm capability includes `schema`.
  - Re-run doctor with `--detail deep --trace`.
  - Validate runtime-only contracts output.

- **Unexpected behavior after updates**
  - Check registration precedence with manage/doctor.
  - Run with `--no-extensions` to isolate core behavior.
  - Re-activate extension after fixing manifest or entry path.
