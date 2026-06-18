# Mixed precision in one GGUF

Omega uses **llama-quantize** `--tensor-type` / `--tensor-type-file` (llama.cpp `tt_overrides`) to produce a single GGUF with per-tensor quant types.

## From Model Studio / API

Pass `tensorTypes` on `QuantizeRequest`:

```json
{
  "inputPath": "C:\\models\\base-f16.gguf",
  "outputName": "model-mixed-q4q8",
  "quant": "Q4_K_M",
  "tensorTypes": [
    { "pattern": "blk\\.[0-9]+\\.attn_q", "ggmlType": "q8_0" },
    { "pattern": "blk\\.[0-9]+\\.ffn_down", "ggmlType": "q5_k" }
  ]
}
```

## CLI (bundled `llama-quantize`)

```powershell
llama-quantize input-f16.gguf output.gguf Q4_K_M `
  --tensor-type "blk.0.attn_q=q8_0" `
  --tensor-type "blk.1.attn_q=q8_0"
```

Or a file (one `pattern=type` per line):

```text
blk\.0\.attn_q=q8_0
blk\.1\.attn_q=q8_0
```

```powershell
llama-quantize input-f16.gguf output.gguf Q4_K_M --tensor-type-file overrides.txt
```

## Runtime `omega_set_layer_quant`

At **inference** time, llama.cpp cannot re-quantize tensors inside a loaded GGUF. `libomega_infer` still supports:

- **File swap** — another GGUF in the same folder with the same stem (e.g. `-Q4_K_M` vs `-Q8_0`)
- **Partial layer policy** — records ranges + `tensor_buft_overrides` tiering (host/GPU), not true mixed dtypes in one file

For true mixed dtypes in one file, quantize offline with the options above, then load the resulting GGUF normally.
