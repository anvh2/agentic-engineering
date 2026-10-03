"""Pure, dependency-free arithmetic for building a CatVTON agnostic mask
from a raw SAM2 segmentation mask's bounding box.

No numpy, no PIL, no ML runtime of any kind - just integer/float math on a
(y0, y1, x0, x1) box, so it is trivially unit testable in any Python
environment. The actual mask pixel data (finding the raw mask's bounding
box via Image.getbbox(), drawing the expanded rectangle, compositing the
preflight overlay, computing coverage from Image.histogram()) is Pillow
work done in comfy_mask_trial.py, which is the only place in this phase
that imports PIL - GroundingDINO/SAM2 themselves run inside ComfyUI's own
process via the HTTP API, never imported here or there.

Why expand at all: a tight segmentation of the CURRENT garment is not a
correct virtual-try-on agnostic mask. The target garment (a Peter Pan collar
that sits higher/wider than a plain crew neck, puffed sleeves wider than a
fitted short sleeve) can extend outside the region the old garment occupied.
CatVTON can only paint the new garment inside whatever region the mask
exposes, so the mask must be generous, not exact.
"""


# --- Anatomical safety clamps -----------------------------------------
# Absolute fractions of image height, independent of any detection/box
# math - these are the hard floor/ceiling nothing below is allowed to cross,
# regardless of what the garment box says.
HEAD_SAFETY_MARGIN_FRAC = 0.12   # mask top can never rise above this
HIP_SAFETY_MARGIN_FRAC = 0.85    # mask bottom can never sink below this

# --- Garment-relative extension amounts ---------------------------------
# Expressed relative to the garment's OWN measured width/neckline, not the
# image or a contaminated raw bounding box - this is what keeps the result
# anchored to the actual segmentation instead of degenerating into "expand
# a box until it looks right".
CORE_HEIGHT_FALLBACK_MULTIPLIER = 3.0  # LAST-RESORT cap, only used when no
                                  # real gap is found in the mask's own row
                                  # profile (e.g. a garment with no waist
                                  # break, like a long dress) - not the
                                  # primary mechanism; see
                                  # find_garment_core_bottom below
GAP_MIN_COVERAGE_FRAC = 0.05     # a row counts as "solid garment" once its
                                  # white-pixel fraction (of image width)
                                  # rises above this
GAP_MIN_RUN_ROWS = 6             # how many consecutive low-coverage rows
                                  # are required before it counts as a real
                                  # gap, not single-row segmentation noise
COLLAR_ALLOWANCE_FRAC = 0.035     # collar rise above the neckline, as a
                                  # fraction of image height (small, fixed -
                                  # NOT scaled by garment box size)
SIDE_PAD_FRAC = 0.08             # small horizontal pad around the core/
                                  # collar region, fraction of torso width
SLEEVE_SIDE_EXTRA_FRAC = 0.28    # extra width per side for the sleeve band,
                                  # fraction of torso width
SLEEVE_BAND_HEIGHT_FRAC = 0.55   # sleeve band only covers this fraction of
                                  # [neck_y, garment_core_bottom] - the
                                  # shoulder/upper-arm area, not the full arm
HEM_EXTENSION_MULTIPLIER = 0.75   # how far below garment_core_bottom the hem
                                  # band extends, fraction of torso width -
                                  # a top/blouse hem drop toward the hip is
                                  # smaller than the garment's own width, not
                                  # comparable to it; HIP_SAFETY_MARGIN_FRAC
                                  # remains the hard backstop regardless
HEM_MIN_WIDTH_FRAC = 0.82           # A loose blouse must not collapse to the fitted base model's waist width.
                                    # Hem/body width will be at least this fraction of shoulder/core width.


def head_safety_floor_y(image_height):
    """The smallest y a mask is ever allowed to reach, regardless of any
    other computation - an absolute clamp against invading the face/head.
    """
    return int(round(HEAD_SAFETY_MARGIN_FRAC * image_height))


def hip_safety_ceiling_y(image_height):
    """The largest y a mask is ever allowed to reach - an absolute clamp
    against invading the lower legs.
    """
    return int(round(HIP_SAFETY_MARGIN_FRAC * image_height))


def find_garment_gap_row(row_coverage, *, start_row, min_coverage_frac=GAP_MIN_COVERAGE_FRAC, min_gap_rows=GAP_MIN_RUN_ROWS):
    """Scan `row_coverage` (a list with one per-row mask-coverage fraction,
    0..1, indexed by image row) starting at `start_row`, and return the row
    index where the garment mask genuinely ends: the first run of at least
    `min_gap_rows` consecutive rows whose coverage drops below
    `min_coverage_frac`, AFTER coverage has risen above that threshold at
    least once (so we don't just stop at row 0's background).

    This reads the actual segmentation's own structure - a real waist/hem
    gap between a cropped top and anything below it - rather than guessing
    a fixed height-to-width ratio, which does not generalize across garment
    lengths (a crop top and a long blouse have very different proportions).
    Returns None if no qualifying gap is found before the end of the list;
    the caller falls back to an absolute safety cap in that case.
    """
    if not (0 <= start_row < len(row_coverage)):
        raise ValueError(f"start_row {start_row} out of range for {len(row_coverage)} rows")

    seen_garment = False
    gap_run_start = None
    for row in range(start_row, len(row_coverage)):
        covered = row_coverage[row] >= min_coverage_frac
        if covered:
            seen_garment = True
            gap_run_start = None
            continue
        if not seen_garment:
            continue  # still inside/above the neckline, not garment yet
        if gap_run_start is None:
            gap_run_start = row
        if row - gap_run_start + 1 >= min_gap_rows:
            return gap_run_start
    return None


def compute_garment_core_bottom(neck_y, torso_width, raw_bottom_y, image_height, row_coverage=None):
    """The y below which the raw SAM mask is no longer trusted.

    Primary mechanism: find_garment_gap_row on the mask's own row-coverage
    profile - the real waist/hem break where the garment visibly ends. This
    is what correctly discards contamination like the rejected run's skirt,
    which sits well below a genuine gap, regardless of what fixed ratio
    would or wouldn't have captured that specific image.

    Fallback (row_coverage not supplied, or no qualifying gap found - e.g.
    a garment with no waist break): the smaller of the raw mask's own
    bottom edge and a generous CORE_HEIGHT_FALLBACK_MULTIPLIER-scaled cap,
    as a last-resort safety net only.
    """
    if torso_width <= 0:
        raise ValueError(f"torso_width must be positive: {torso_width}")

    if row_coverage is not None:
        gap_row = find_garment_gap_row(row_coverage, start_row=neck_y)
        if gap_row is not None:
            return int(min(gap_row, image_height))

    fallback_cap = neck_y + CORE_HEIGHT_FALLBACK_MULTIPLIER * torso_width
    return int(min(raw_bottom_y, fallback_cap, image_height))


def collar_band_box(neck_y, x0, x1, image_shape):
    """(y0, y1, x0, x1) strip just above the shoulder line, for collar
    coverage. Width stays close to the garment's own width (+ small pad) -
    this is not a full-image-width band. Top is clamped to the absolute
    head-safety floor no matter how large COLLAR_ALLOWANCE_FRAC computes to.
    """
    height, width = image_shape
    if x1 <= x0:
        raise ValueError(f"x1 must be greater than x0: x0={x0}, x1={x1}")
    torso_width = x1 - x0
    collar_allowance_px = int(round(COLLAR_ALLOWANCE_FRAC * height))
    top = max(head_safety_floor_y(height), neck_y - collar_allowance_px)
    pad = int(round(SIDE_PAD_FRAC * torso_width))
    left = max(0, x0 - pad)
    right = min(width, x1 + pad)
    return top, neck_y, left, right


def sleeve_band_box(neck_y, garment_core_bottom, x0, x1, image_shape):
    """(y0, y1, x0, x1) band covering only the shoulder/upper-arm portion
    of the garment's height (SLEEVE_BAND_HEIGHT_FRAC of its total height),
    widened laterally for sleeve allowance - never the full arm length, and
    never the full image width.
    """
    height, width = image_shape
    if x1 <= x0:
        raise ValueError(f"x1 must be greater than x0: x0={x0}, x1={x1}")
    if garment_core_bottom <= neck_y:
        raise ValueError(f"garment_core_bottom must be below neck_y: {garment_core_bottom} <= {neck_y}")
    torso_width = x1 - x0
    extra = int(round(SLEEVE_SIDE_EXTRA_FRAC * torso_width))
    band_bottom = neck_y + int(round(SLEEVE_BAND_HEIGHT_FRAC * (garment_core_bottom - neck_y)))
    left = max(0, x0 - extra)
    right = min(width, x1 + extra)
    return neck_y, band_bottom, left, right


def hem_band_box(
    garment_core_bottom,
    shoulder_x0,
    shoulder_x1,
    taper_x0,
    taper_x1,
    image_shape,
):
    """C4 loose-blouse continuation.

    Extend the upper-garment mask continuously from the current shirt hem
    toward the upper hip. Keep enough width for a loose blouse instead of
    following the fitted base model's waist/skirt geometry.
    """
    height, width = image_shape

    if shoulder_x1 <= shoulder_x0:
        raise ValueError(
            f"invalid shoulder extent: {shoulder_x0}, {shoulder_x1}"
        )

    shoulder_width = shoulder_x1 - shoulder_x0
    center_x = (shoulder_x0 + shoulder_x1) / 2.0

    # Loose blouse body: 82% of shoulder/core width.
    body_width = int(round(shoulder_width * 0.82))

    left = int(round(center_x - body_width / 2))
    right = left + body_width

    left = max(0, left)
    right = min(width, right)

    # Continue DIRECTLY from shirt hem.
    top = garment_core_bottom

    # Enough room for a normal-length blouse, but never below upper hip.
    extension = int(round(shoulder_width * 0.75))
    bottom = min(
        top + extension,
        int(round(height * 0.68)),
        height,
    )

    return top, bottom, left, right


def resolve_hem_taper_extent(shoulder_x0, shoulder_x1, local_x0, local_x1):
    """Resolve lower-body extent for a loose blouse.

    The previous B3 implementation followed the fitted base T-shirt's
    waist measurement too closely. That creates an hourglass/T-shaped
    agnostic region and does not leave enough space for a loose blouse.

    C4 still uses the measured local torso extent, but guarantees that
    the lower garment region remains at least HEM_MIN_WIDTH_FRAC of
    the shoulder/core width.
    """
    if shoulder_x1 <= shoulder_x0:
        raise ValueError(
            f"shoulder_x1 must be greater than shoulder_x0: "
            f"{shoulder_x0}, {shoulder_x1}"
        )

    shoulder_width = shoulder_x1 - shoulder_x0
    center_x = (shoulder_x0 + shoulder_x1) / 2.0

    min_width = int(round(HEM_MIN_WIDTH_FRAC * shoulder_width))

    # No usable local measurement -> use loose-blouse minimum.
    if local_x0 is None or local_x1 is None or local_x1 <= local_x0:
        desired_width = min_width
    else:
        local_width = local_x1 - local_x0
        desired_width = max(local_width, min_width)

    # Never exceed the outer shoulder/core envelope.
    desired_width = min(desired_width, shoulder_width)

    left = int(round(center_x - desired_width / 2.0))
    right = left + desired_width

    left = max(shoulder_x0, left)
    right = min(shoulder_x1, right)

    return left, right


def mask_coverage_fraction(white_pixel_count, total_pixel_count):
    """Fraction of the image a mask covers, from plain pixel counts (e.g.
    Pillow's Image.histogram() bucket sums) - a cheap preflight sanity
    signal. A near-zero or near-total coverage almost always means
    detection/expansion went wrong, not that the mask is unusually precise.
    """
    if total_pixel_count <= 0:
        raise ValueError(f"total_pixel_count must be positive: {total_pixel_count}")
    if not (0 <= white_pixel_count <= total_pixel_count):
        raise ValueError(
            f"white_pixel_count ({white_pixel_count}) must be between 0 and "
            f"total_pixel_count ({total_pixel_count})"
        )
    return white_pixel_count / total_pixel_count
