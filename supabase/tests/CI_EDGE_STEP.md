# Coordinator note (`.github/**` is not owned by Grok)

To satisfy issue #18 acceptance ("CI реально виконує тести функцій"), add to `db-tests` after SQL tests:

```yaml
      - name: Edge Auth probe and negative function tests
        if: steps.detect.outputs.run == 'true'
        run: |
          curl -fsSL https://deno.land/install.sh | sh
          echo "$HOME/.deno/bin" >> "$GITHUB_PATH"
          bash supabase/tests/run_edge_g2b.sh
```

No repository secrets required. Uses local stack only.
