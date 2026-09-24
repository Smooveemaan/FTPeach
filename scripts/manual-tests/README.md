# Manual fixtures

`create-icon-category-samples.ps1` creates dummy files (image, archive, code, and
other types) for manually checking file-type icons and size formatting:

```powershell
powershell -File scripts/manual-tests/create-icon-category-samples.ps1 -TargetDirectory <dir>
```

For native application checks, use the [packaged smoke harness](../packaged-smoke/README.md).
For protocol scenarios, use `npm run servers:test`; see the
[protocol support guide](../../docs/protocol-support.md).
