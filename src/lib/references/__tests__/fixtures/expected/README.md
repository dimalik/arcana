# Expected Reference Lists

Each `.json` file here corresponds to a PDF in the parent `fixtures/` directory.
The filename must match `<pdf-name>.expected.json`.

Format:

```json
{
  "refs": [
    { "title": "...", "year": 2017, "doi": "10.xxx/yyy" },
    { "title": "...", "year": 2019 }
  ]
}
```

To add a new paper to the benchmark:

1. Place an OA PDF (CC-BY or CC0) in `fixtures/`
2. Create a matching `.expected.json` with the ground-truth reference list
3. Run `npx tsx scripts/benchmark-references.ts --capture` to generate the baseline snapshot
4. Run `npx tsx scripts/benchmark-references.ts --report` to regenerate the baseline metrics note
5. Commit the snapshot to `__tests__/recorded/` and the baseline note in `docs/superpowers/notes/`
