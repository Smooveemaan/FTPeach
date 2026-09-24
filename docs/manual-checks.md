# Manual checks

Some statements in the [user guide](user-guide.md) can only be confirmed by a
person running the real application. Each run is recorded here, and the guide
points to it with `<!-- verified-by: manual <heading> -->`, which
`npm run check:verified-by` requires to match a heading below.

Record a run as:

```markdown
### <short name of the scenario>

- Version: 0.2.3 (commit abc1234)
- Date: 2026-09-24
- Steps: what was done, against which server
- Result: what happened
```

Repeat the run and update the record when the behavior it covers changes.

No manual checks are recorded yet.
