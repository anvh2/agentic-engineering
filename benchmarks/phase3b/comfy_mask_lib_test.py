"""Unit tests for comfy_mask_lib.py - pure integer/float arithmetic, no
numpy, no PIL, no ComfyUI, no network, no ML models of any kind. Run with:
    python3 -m unittest benchmarks/phase3b/comfy_mask_lib_test.py -v
"""
import unittest

import comfy_mask_lib as lib

IMAGE_SHAPE = (1024, 576)  # (height, width) - matches the accepted A2 person-base image


class SafetyFloorCeilingTests(unittest.TestCase):
    def test_head_safety_floor_is_a_fraction_of_image_height(self):
        self.assertEqual(lib.head_safety_floor_y(1000), 120)

    def test_hip_safety_ceiling_is_a_fraction_of_image_height(self):
        self.assertEqual(lib.hip_safety_ceiling_y(1000), 850)

    def test_floor_is_always_below_ceiling(self):
        for h in (100, 500, 1024, 4000):
            self.assertLess(lib.head_safety_floor_y(h), lib.hip_safety_ceiling_y(h))


def _flat_row_coverage(length, *segments):
    """Build a synthetic per-row coverage profile from (end_row, value)
    segments, e.g. [(235, 0.0), (515, 0.3), (530, 0.01), (751, 0.2), (1024, 0.0)]
    means rows [0,235)=0.0, [235,515)=0.3, [530,751)=0.2, etc.
    """
    profile = [0.0] * length
    start = 0
    for end, value in segments:
        for row in range(start, min(end, length)):
            profile[row] = value
        start = end
    return profile


# Models the ACTUAL rejected run's raw mask (sampled directly from
# benchmarks/phase3b/comfy-run-01/mask/sam2-segmentation-mask.png): solid
# shirt coverage from the shoulder line, a genuine near-zero gap at the
# waist/hem, then contamination (the skirt) resuming below it.
REJECTED_RUN_ROW_COVERAGE = _flat_row_coverage(
    1024,
    (235, 0.0),    # above the shoulder line: background/head
    (515, 0.30),   # solid crop-top: well above GAP_MIN_COVERAGE_FRAC
    (530, 0.01),   # the real waist gap: below threshold, 15 rows - qualifies
    (751, 0.20),   # the skirt: contamination, still "covered" by threshold
    (1024, 0.0),
)


class FindGarmentGapRowTests(unittest.TestCase):
    def test_finds_the_real_gap_in_the_rejected_runs_actual_mask_profile(self):
        gap_row = lib.find_garment_gap_row(REJECTED_RUN_ROW_COVERAGE, start_row=235)
        self.assertIsNotNone(gap_row)
        self.assertGreaterEqual(gap_row, 515)
        self.assertLess(gap_row, 530)

    def test_does_not_stop_at_a_single_row_noise_blip(self):
        # A one-row dip inside otherwise-solid garment coverage must not be
        # mistaken for the real hem gap (min_gap_rows requires a run).
        profile = _flat_row_coverage(1024, (235, 0.0), (300, 0.3), (301, 0.0), (700, 0.3), (1024, 0.0))
        gap_row = lib.find_garment_gap_row(profile, start_row=235)
        # The only qualifying multi-row gap is after row 700.
        self.assertGreaterEqual(gap_row, 700)

    def test_returns_none_when_no_gap_exists_before_the_end_of_the_profile(self):
        # A garment with no waist break at all (e.g. a long dress) - solid
        # coverage all the way down.
        profile = _flat_row_coverage(1024, (235, 0.0), (1024, 0.3))
        self.assertIsNone(lib.find_garment_gap_row(profile, start_row=235))

    def test_ignores_background_above_the_neckline(self):
        # Rows before start_row (and the initial low-coverage stretch above
        # the garment) must never be mistaken for the gap.
        gap_row = lib.find_garment_gap_row(REJECTED_RUN_ROW_COVERAGE, start_row=0)
        self.assertGreaterEqual(gap_row, 515)

    def test_rejects_out_of_range_start_row(self):
        with self.assertRaises(ValueError):
            lib.find_garment_gap_row([0.1] * 10, start_row=20)


class ComputeGarmentCoreBottomTests(unittest.TestCase):
    def test_uses_the_real_gap_from_row_coverage_when_available(self):
        # This is the direct regression for the rejected run: with the
        # actual row-coverage profile supplied, the skirt contamination
        # (which extends to raw_bottom_y=751) must be discarded in favor of
        # the real gap at the waist (~515-529), not a guessed ratio.
        bottom = lib.compute_garment_core_bottom(
            neck_y=235, torso_width=279, raw_bottom_y=751, image_height=1024,
            row_coverage=REJECTED_RUN_ROW_COVERAGE,
        )
        self.assertGreaterEqual(bottom, 515)
        self.assertLess(bottom, 530)
        self.assertLess(bottom, 751)

    def test_falls_back_to_raw_bottom_when_plausible_and_no_row_coverage_given(self):
        # No row_coverage supplied at all - falls back to the raw bottom
        # edge, since it's well within the generous fallback cap.
        bottom = lib.compute_garment_core_bottom(neck_y=200, torso_width=300, raw_bottom_y=500, image_height=1024)
        self.assertEqual(bottom, 500)

    def test_falls_back_to_the_safety_multiplier_when_no_gap_and_raw_bottom_implausible(self):
        # No gap in the profile (garment with no waist break) AND a raw
        # bottom that would otherwise run off past a plausible garment
        # length - the fallback multiplier cap must still apply.
        profile = _flat_row_coverage(1024, (200, 0.0), (1024, 0.3))  # solid, no gap, all the way down
        fallback_cap = 200 + lib.CORE_HEIGHT_FALLBACK_MULTIPLIER * 200
        bottom = lib.compute_garment_core_bottom(
            neck_y=200, torso_width=200, raw_bottom_y=int(fallback_cap) + 150, image_height=1024, row_coverage=profile
        )
        self.assertLessEqual(bottom, fallback_cap)

    def test_never_exceeds_image_height(self):
        bottom = lib.compute_garment_core_bottom(neck_y=990, torso_width=500, raw_bottom_y=2000, image_height=1024)
        self.assertLessEqual(bottom, 1024)

    def test_rejects_non_positive_torso_width(self):
        with self.assertRaises(ValueError):
            lib.compute_garment_core_bottom(neck_y=200, torso_width=0, raw_bottom_y=500, image_height=1024)


class CollarBandBoxTests(unittest.TestCase):
    def test_never_rises_above_the_head_safety_floor(self):
        # neck_y placed unrealistically close to the top of the image -
        # the collar allowance alone would push above frame 0, but the
        # absolute head-safety floor must still hold.
        top, bottom, left, right = lib.collar_band_box(neck_y=10, x0=200, x1=400, image_shape=IMAGE_SHAPE)
        self.assertGreaterEqual(top, lib.head_safety_floor_y(IMAGE_SHAPE[0]))

    def test_stays_within_image_bounds(self):
        top, bottom, left, right = lib.collar_band_box(neck_y=250, x0=163, x1=442, image_shape=IMAGE_SHAPE)
        self.assertGreaterEqual(top, 0)
        self.assertGreaterEqual(left, 0)
        self.assertLessEqual(right, IMAGE_SHAPE[1])
        self.assertLessEqual(bottom, IMAGE_SHAPE[0])

    def test_width_stays_close_to_garment_width_not_full_image(self):
        top, bottom, left, right = lib.collar_band_box(neck_y=250, x0=163, x1=442, image_shape=IMAGE_SHAPE)
        band_width = right - left
        self.assertLess(band_width, IMAGE_SHAPE[1])
        garment_width = 442 - 163
        self.assertLess(band_width, garment_width * 1.3)

    def test_rejects_degenerate_zero_width_box(self):
        with self.assertRaises(ValueError):
            lib.collar_band_box(neck_y=250, x0=200, x1=200, image_shape=IMAGE_SHAPE)


class SleeveBandBoxTests(unittest.TestCase):
    def test_expands_laterally_without_covering_the_full_image_width(self):
        top, bottom, left, right = lib.sleeve_band_box(
            neck_y=235, garment_core_bottom=751, x0=163, x1=442, image_shape=IMAGE_SHAPE
        )
        band_width = right - left
        self.assertLess(band_width, IMAGE_SHAPE[1])

    def test_covers_only_the_shoulder_upper_arm_portion_not_the_full_arm_length(self):
        neck_y, garment_core_bottom = 235, 751
        top, bottom, left, right = lib.sleeve_band_box(
            neck_y=neck_y, garment_core_bottom=garment_core_bottom, x0=163, x1=442, image_shape=IMAGE_SHAPE
        )
        garment_height = garment_core_bottom - neck_y
        band_height = bottom - top
        self.assertLess(band_height, garment_height)
        self.assertAlmostEqual(band_height, lib.SLEEVE_BAND_HEIGHT_FRAC * garment_height, delta=2)

    def test_stays_within_image_bounds(self):
        top, bottom, left, right = lib.sleeve_band_box(
            neck_y=235, garment_core_bottom=751, x0=163, x1=442, image_shape=IMAGE_SHAPE
        )
        self.assertGreaterEqual(left, 0)
        self.assertLessEqual(right, IMAGE_SHAPE[1])

    def test_rejects_core_bottom_at_or_above_neck(self):
        with self.assertRaises(ValueError):
            lib.sleeve_band_box(neck_y=500, garment_core_bottom=500, x0=163, x1=442, image_shape=IMAGE_SHAPE)


class HemBandBoxTests(unittest.TestCase):
    def test_downward_extension_is_bounded_by_the_hip_safety_ceiling(self):
        # A very wide shoulder width would otherwise push the hem extension
        # (HEM_EXTENSION_MULTIPLIER * shoulder_width) well past the hips.
        top, bottom, left, right = lib.hem_band_box(
            garment_core_bottom=700, shoulder_x0=50, shoulder_x1=550,
            taper_x0=200, taper_x1=400, image_shape=IMAGE_SHAPE,  # 500px-wide shoulders
        )
        self.assertLessEqual(bottom, lib.hip_safety_ceiling_y(IMAGE_SHAPE[0]))

    def test_never_exceeds_image_height_even_with_no_hip_clamp_headroom(self):
        top, bottom, left, right = lib.hem_band_box(
            garment_core_bottom=1020, shoulder_x0=50, shoulder_x1=550,
            taper_x0=200, taper_x1=400, image_shape=IMAGE_SHAPE,
        )
        self.assertLessEqual(bottom, IMAGE_SHAPE[0])

    def test_width_follows_the_supplied_taper_extent_not_the_shoulder_bbox(self):
        # The whole point of the fix: hem width comes from the measured
        # waist-local (taper) extent, which is narrower than the garment's
        # shoulder-derived outer bbox - not the shoulder bbox itself.
        shoulder_x0, shoulder_x1 = 163, 442
        taper_x0, taper_x1 = 200, 400  # narrower than the shoulders
        top, bottom, left, right = lib.hem_band_box(
            garment_core_bottom=516, shoulder_x0=shoulder_x0, shoulder_x1=shoulder_x1,
            taper_x0=taper_x0, taper_x1=taper_x1, image_shape=IMAGE_SHAPE,
        )
        self.assertEqual(left, taper_x0)
        self.assertEqual(right, taper_x1)
        self.assertLess(right - left, shoulder_x1 - shoulder_x0)

    def test_length_still_scales_with_shoulder_width_even_though_taper_is_narrower(self):
        # Body-size scale for HOW FAR DOWN the band extends must keep using
        # the shoulder width, not shrink just because the taper is narrow -
        # length and shape are deliberately decoupled.
        narrow_taper_top, narrow_taper_bottom, *_ = lib.hem_band_box(
            garment_core_bottom=516, shoulder_x0=163, shoulder_x1=442,
            taper_x0=250, taper_x1=350, image_shape=(2000, 2000),  # tall canvas, no hip clamp interference
        )
        wide_taper_top, wide_taper_bottom, *_ = lib.hem_band_box(
            garment_core_bottom=516, shoulder_x0=163, shoulder_x1=442,
            taper_x0=163, taper_x1=442, image_shape=(2000, 2000),
        )
        self.assertEqual(narrow_taper_bottom, wide_taper_bottom)

    def test_rejects_invalid_taper_extent(self):
        with self.assertRaises(ValueError):
            lib.hem_band_box(516, 163, 442, taper_x0=300, taper_x1=300, image_shape=IMAGE_SHAPE)


class MaskAnchoredToRealSegmentationTests(unittest.TestCase):
    """Regression coverage for 'the final mask must not degenerate into one
    giant rectangle spanning the whole detected region' - checked by
    confirming each band is independently narrower/shorter than a naive
    full-bbox rectangle would be, using realistic numbers from the
    rejected run's own mask-summary.json.
    """

    RAW_BBOX = (235, 751, 163, 442)  # (y0, y1, x0, x1) from the rejected run

    # A waist-local extent narrower than the shoulders - what a real tapered
    # torso silhouette measures near garment_core_bottom.
    TAPER_X = (200, 400)

    def test_none_of_the_three_bands_together_reconstruct_a_single_rectangle(self):
        neck_y, raw_y1, x0, x1 = self.RAW_BBOX
        torso_width = x1 - x0
        core_bottom = lib.compute_garment_core_bottom(
            neck_y, torso_width, raw_y1, IMAGE_SHAPE[0], row_coverage=REJECTED_RUN_ROW_COVERAGE
        )
        collar = lib.collar_band_box(neck_y, x0, x1, IMAGE_SHAPE)
        sleeve = lib.sleeve_band_box(neck_y, core_bottom, x0, x1, IMAGE_SHAPE)
        hem = lib.hem_band_box(core_bottom, x0, x1, *self.TAPER_X, IMAGE_SHAPE)
        # If every band had identical width, the result would effectively
        # be a single rectangle again - they must differ (sleeve widest,
        # hem narrowest - tapered to the waist, not the shoulders).
        self.assertEqual(hem[3] - hem[2], self.TAPER_X[1] - self.TAPER_X[0])
        self.assertGreater(sleeve[3] - sleeve[2], hem[3] - hem[2])
        self.assertLess(hem[3] - hem[2], x1 - x0, "hem must be narrower than the shoulder-width bbox")

    def test_hem_band_stays_horizontally_within_the_shoulder_bbox(self):
        # A necessary (not sufficient on its own, but load-bearing) proxy
        # for "connected to the upper garment mask, not a detached region
        # floating beside it": the hem's x-range must be a subset of the
        # garment's own outer x-range, never extending past it sideways.
        neck_y, raw_y1, x0, x1 = self.RAW_BBOX
        core_bottom = lib.compute_garment_core_bottom(
            neck_y, x1 - x0, raw_y1, IMAGE_SHAPE[0], row_coverage=REJECTED_RUN_ROW_COVERAGE
        )
        hem = lib.hem_band_box(core_bottom, x0, x1, *self.TAPER_X, IMAGE_SHAPE)
        self.assertGreaterEqual(hem[2], x0)
        self.assertLessEqual(hem[3], x1)

    def test_hem_band_top_is_exactly_the_core_bottom_no_vertical_gap(self):
        # The other half of "connected": the hem band's top row must equal
        # garment_core_bottom exactly (the row the core was clipped at), so
        # the two regions are pixel-adjacent with no gap between them.
        neck_y, raw_y1, x0, x1 = self.RAW_BBOX
        core_bottom = lib.compute_garment_core_bottom(
            neck_y, x1 - x0, raw_y1, IMAGE_SHAPE[0], row_coverage=REJECTED_RUN_ROW_COVERAGE
        )
        hem = lib.hem_band_box(core_bottom, x0, x1, *self.TAPER_X, IMAGE_SHAPE)
        self.assertEqual(hem[0], core_bottom)

    def test_core_bottom_discards_the_rejected_runs_actual_skirt_contamination(self):
        # The rejected run's raw mask bottom (751) reflects a mask that had
        # unioned in the skirt below the waist. With the real row-coverage
        # profile, the core bottom must land at the genuine gap, well above
        # the skirt.
        neck_y, raw_y1, x0, x1 = self.RAW_BBOX
        torso_width = x1 - x0
        core_bottom = lib.compute_garment_core_bottom(
            neck_y, torso_width, raw_y1, IMAGE_SHAPE[0], row_coverage=REJECTED_RUN_ROW_COVERAGE
        )
        self.assertLess(core_bottom, raw_y1)


class EmptyMaskFailsCleanlyTests(unittest.TestCase):
    """A caller-side empty mask (PIL Image.getbbox() returning None) is
    handled in comfy_mask_trial.py before any of these functions are ever
    called - these are the pure-function-level degenerate cases that must
    also fail loudly rather than silently producing a nonsense mask.
    """

    def test_zero_width_garment_rejected_by_every_band_function(self):
        for fn in (
            lambda: lib.collar_band_box(200, 300, 300, IMAGE_SHAPE),
            lambda: lib.sleeve_band_box(200, 500, 300, 300, IMAGE_SHAPE),
            lambda: lib.hem_band_box(500, 300, 300, taper_x0=310, taper_x1=320, image_shape=IMAGE_SHAPE),
            lambda: lib.hem_band_box(500, 200, 400, taper_x0=300, taper_x1=300, image_shape=IMAGE_SHAPE),
        ):
            with self.assertRaises(ValueError):
                fn()

    def test_zero_torso_width_rejected_by_core_bottom(self):
        with self.assertRaises(ValueError):
            lib.compute_garment_core_bottom(neck_y=200, torso_width=0, raw_bottom_y=500, image_height=1024)


class ResolveHemTaperExtentTests(unittest.TestCase):
    def test_prefers_the_measured_local_extent_when_valid(self):
        x0, x1 = lib.resolve_hem_taper_extent(shoulder_x0=163, shoulder_x1=442, local_x0=220, local_x1=380)
        self.assertEqual((x0, x1), (220, 380))

    def test_falls_back_to_shoulder_extent_when_local_is_none(self):
        x0, x1 = lib.resolve_hem_taper_extent(shoulder_x0=163, shoulder_x1=442, local_x0=None, local_x1=None)
        self.assertEqual((x0, x1), (163, 442))

    def test_falls_back_to_shoulder_extent_when_local_is_degenerate(self):
        x0, x1 = lib.resolve_hem_taper_extent(shoulder_x0=163, shoulder_x1=442, local_x0=300, local_x1=300)
        self.assertEqual((x0, x1), (163, 442))

    def test_clamps_a_local_extent_that_exceeds_the_shoulder_bbox(self):
        x0, x1 = lib.resolve_hem_taper_extent(shoulder_x0=163, shoulder_x1=442, local_x0=100, local_x1=500)
        self.assertEqual((x0, x1), (163, 442))


class MaskCoverageFractionTests(unittest.TestCase):
    def test_full_coverage_is_one(self):
        self.assertEqual(lib.mask_coverage_fraction(100, 100), 1.0)

    def test_zero_coverage_is_zero(self):
        self.assertEqual(lib.mask_coverage_fraction(0, 100), 0.0)

    def test_quarter_covered(self):
        self.assertAlmostEqual(lib.mask_coverage_fraction(25, 100), 0.25)

    def test_rejects_non_positive_total(self):
        with self.assertRaises(ValueError):
            lib.mask_coverage_fraction(0, 0)

    def test_rejects_white_count_exceeding_total(self):
        with self.assertRaises(ValueError):
            lib.mask_coverage_fraction(150, 100)

    def test_rejects_negative_white_count(self):
        with self.assertRaises(ValueError):
            lib.mask_coverage_fraction(-1, 100)


if __name__ == "__main__":
    unittest.main()
