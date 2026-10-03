"""Unit tests for comfy_person_base_lib.py - pure graph-building logic,
no ComfyUI required. Run with:
    python3 -m unittest benchmarks/phase3b/comfy_person_base_lib_test.py -v
"""
import unittest

import comfy_person_base_lib as lib


class BuildGraphTests(unittest.TestCase):
    def _graph(self, **overrides):
        kwargs = dict(checkpoint_name="realisticVisionV60B1.safetensors", seed=1, filename_prefix="test")
        kwargs.update(overrides)
        return lib.build_graph(**kwargs)

    def test_returns_seven_nodes(self):
        self.assertEqual(len(self._graph()), 7)

    def test_full_txt2img_denoise(self):
        self.assertEqual(self._graph()["5"]["inputs"]["denoise"], 1.0)

    def test_no_garment_or_ipadapter_node_types_present(self):
        graph = self._graph()
        class_types = {n["class_type"] for n in graph.values()}
        self.assertNotIn("IPAdapterAdvanced", class_types)
        self.assertNotIn("IPAdapterUnifiedLoader", class_types)

    def test_rejects_non_positive_steps(self):
        with self.assertRaises(ValueError):
            self._graph(steps=0)

    def test_positive_prompt_states_coverage_affirmatively_not_as_negation(self):
        # Regression for the rejected run: "nothing covering the chest" in
        # the positive prompt produced a tank top, since CLIP doesn't parse
        # negation - the fix states garment coverage as positive facts only.
        positive = lib.POSITIVE_PROMPT.lower()
        self.assertNotIn("nothing covering", positive)
        self.assertNotIn("no jacket", positive)
        self.assertNotIn("no scarf", positive)
        self.assertIn("covering the shoulders", positive)
        self.assertIn("crew-neck", positive)

    def test_positive_prompt_asks_for_full_body_wide_framing(self):
        positive = lib.POSITIVE_PROMPT.lower()
        self.assertIn("full length", positive)
        self.assertIn("mid-thigh", positive)

    def test_negative_prompt_names_every_observed_failure_mode(self):
        # Regression for the rejected run's specific artifacts: spaghetti
        # straps, a choker, and matching arm bands.
        negative = lib.NEGATIVE_PROMPT.lower()
        for failure_token in [
            "tank top",
            "spaghetti straps",
            "choker",
            "arm band",
            "bust shot",
            "cropped at chest",
        ]:
            self.assertIn(failure_token, negative)

    def test_negative_prompt_still_covers_crossed_arms(self):
        self.assertIn("crossed arms", lib.NEGATIVE_PROMPT.lower())

    def test_default_canvas_is_tall_enough_for_hip_thigh_framing(self):
        graph = self._graph()
        latent = graph["4"]["inputs"]
        self.assertGreaterEqual(latent["height"], 1024)
        self.assertGreater(latent["height"], latent["width"])

    def test_save_image_consumes_decoded_output(self):
        graph = self._graph()
        self.assertEqual(graph["7"]["inputs"]["images"], ["6", 0])


if __name__ == "__main__":
    unittest.main()
