"""Numerical-equivalence tests for the chunked-attention implementation
added to Comfyui-CatVTON/model/attn_processor.py
(_chunked_scaled_dot_product_attention).

This tests third-party vendored code that depends on torch, which is only
installed in ComfyUI's own Python interpreter - NOT the harness python3.
Run explicitly with that interpreter:

    /opt/homebrew/bin/python3.11 benchmarks/phase3b/test_chunked_attention.py

Small CPU tensors only (largest case here is 200x64 = 12800 float32 elements
per q/k/v). No model, no checkpoint, no UNet, no GPU/MPS - this is a pure
math check of the tiling logic against plain torch.nn.functional, not
CatVTON inference.
"""
import sys
import unittest
from pathlib import Path

COMFYUI_CATVTON_MODEL_DIR = Path("/Users/anvh/Documents/comfy/ComfyUI/custom_nodes/Comfyui-CatVTON/model")
sys.path.insert(0, str(COMFYUI_CATVTON_MODEL_DIR))

import torch
import torch.nn.functional as F

from attn_processor import _chunked_scaled_dot_product_attention  # noqa: E402


def _random_qkv(batch, heads, seq_q, seq_k, head_dim, seed):
    g = torch.Generator().manual_seed(seed)
    query = torch.randn(batch, heads, seq_q, head_dim, generator=g)
    key = torch.randn(batch, heads, seq_k, head_dim, generator=g)
    value = torch.randn(batch, heads, seq_k, head_dim, generator=g)
    return query, key, value


class ChunkedAttentionEquivalenceTests(unittest.TestCase):
    def _assert_matches_full_attention(self, batch, heads, seq_q, seq_k, head_dim, chunk_size, seed=0, attn_mask=None):
        query, key, value = _random_qkv(batch, heads, seq_q, seq_k, head_dim, seed)
        full = F.scaled_dot_product_attention(query, key, value, attn_mask=attn_mask, dropout_p=0.0, is_causal=False)
        chunked = _chunked_scaled_dot_product_attention(query, key, value, attn_mask, chunk_size)
        self.assertEqual(chunked.shape, full.shape)
        max_abs_diff = (chunked - full).abs().max().item()
        self.assertTrue(
            torch.allclose(chunked, full, atol=1e-5, rtol=1e-4),
            f"chunked attention diverged from full attention: max abs diff = {max_abs_diff}",
        )

    def test_same_shape_as_full_attention(self):
        query, key, value = _random_qkv(2, 4, 37, 37, 8, seed=1)
        chunked = _chunked_scaled_dot_product_attention(query, key, value, None, chunk_size=16)
        self.assertEqual(chunked.shape, (2, 4, 37, 8))

    def test_numerically_close_to_full_attention_chunk_size_evenly_divides_seq(self):
        # seq_q=64, chunk_size=16 -> exactly 4 chunks, no remainder.
        self._assert_matches_full_attention(batch=2, heads=4, seq_q=64, seq_k=64, head_dim=8, chunk_size=16)

    def test_numerically_close_with_multiple_chunk_sizes(self):
        for chunk_size in (4, 8, 32, 64, 128):
            with self.subTest(chunk_size=chunk_size):
                self._assert_matches_full_attention(
                    batch=1, heads=2, seq_q=96, seq_k=96, head_dim=8, chunk_size=chunk_size, seed=chunk_size
                )

    def test_sequence_length_not_divisible_by_chunk_size(self):
        # seq_q=101 is prime relative to every chunk size below - every case
        # forces a ragged final chunk.
        for chunk_size in (7, 16, 30, 64):
            with self.subTest(chunk_size=chunk_size):
                self._assert_matches_full_attention(
                    batch=1, heads=3, seq_q=101, seq_k=101, head_dim=8, chunk_size=chunk_size, seed=100 + chunk_size
                )

    def test_query_and_key_sequence_lengths_may_differ(self):
        # Realistic for this model: seq_q == seq_k always in self-attention,
        # but the tiling logic itself doesn't assume that - confirm it
        # still matches full attention when they differ.
        self._assert_matches_full_attention(batch=1, heads=2, seq_q=50, seq_k=80, head_dim=8, chunk_size=13)

    def test_chunk_size_larger_than_sequence_length_is_a_single_chunk(self):
        self._assert_matches_full_attention(batch=1, heads=2, seq_q=20, seq_k=20, head_dim=8, chunk_size=1000)

    def test_chunk_size_of_one(self):
        # The extreme case: every query token processed individually.
        self._assert_matches_full_attention(batch=1, heads=2, seq_q=17, seq_k=17, head_dim=8, chunk_size=1)

    def test_matches_full_attention_with_an_attention_mask(self):
        batch, heads, seq_q, seq_k, head_dim = 1, 2, 40, 40, 8
        query, key, value = _random_qkv(batch, heads, seq_q, seq_k, head_dim, seed=7)
        mask = torch.zeros(batch, heads, seq_q, seq_k)
        mask[:, :, :, seq_k // 2:] = float("-inf")  # mask out the second half of keys
        full = F.scaled_dot_product_attention(query, key, value, attn_mask=mask, dropout_p=0.0, is_causal=False)
        chunked = _chunked_scaled_dot_product_attention(query, key, value, mask, chunk_size=9)
        self.assertTrue(torch.allclose(chunked, full, atol=1e-5, rtol=1e-4))

    def test_realistic_stage0_head_dim_and_head_count_small_scale(self):
        # Same head_dim=8 as the real SD1.5-inpainting UNet's stage-0
        # attention (see comfy_catvton_lib.py's docstring), at a small
        # enough seq_len to stay a fast CPU unit test.
        self._assert_matches_full_attention(batch=2, heads=40, seq_q=200, seq_k=200, head_dim=8, chunk_size=64)


if __name__ == "__main__":
    unittest.main()
