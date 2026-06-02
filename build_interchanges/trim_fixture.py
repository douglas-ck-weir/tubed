"""Trim a TfL Stop Structure XML response down to just the elements the
parser actually reads, so it can be committed as a small test fixture.

Run: python3 -m build_interchanges.trim_fixture <input.xml> <output.xml>

Keeps:
  * The root <itdRequest> element (and its session metadata for context)
  * <stopAreaLines> blocks whose stopArea/itdPoint has areaType in {81, 65}
    (the platform area types the parser inspects)
  * <footpathInfo> elements (the interchange duration data)

Drops:
  * Bus/rail itdServingLine entries with non-tube symbols (the noise)
  * stopAreaLines for non-platform areaTypes (32, 36, 4096, 97, ...)
  * Any other elements that don't influence the parser's output

This reduces the typical fixture from MB-scale to KB-scale while keeping
the structure that the parser exercises.
"""

import sys
import xml.etree.ElementTree as ET


PLATFORM_AREA_TYPES = {'81', '65'}


def trim(input_xml: str) -> str:
    root = ET.fromstring(input_xml)

    # Collect (gid, area) tuples for all platform areas we want to keep.
    kept_keys = set()
    for sals_parent in root.findall('.//stopAreaLinesSeq'):
        for sal in list(sals_parent):
            sa = sal.find('stopArea')
            if sa is None or sa.get('areaType', '') not in PLATFORM_AREA_TYPES:
                sals_parent.remove(sal)
                continue
            pt = sa.find('itdPoint')
            if pt is not None:
                kept_keys.add((pt.get('gid', ''), pt.get('area', '')))
            # Strip the bulky itdServingLine metadata subtree, keeping only
            # the symbol attribute the parser reads. This eliminates the
            # itdRouteDescText / itdOperator / motDivaParams children.
            for sl in sal.findall('.//itdServingLine'):
                for child in list(sl):
                    sl.remove(child)
                for attr in list(sl.attrib):
                    if attr != 'symbol':
                        del sl.attrib[attr]

    # Drop <footpathInfo> entries whose endpoints aren't between two of our
    # kept platform areas. Also strip the bulky footpathPartInfos children
    # that the parser doesn't look at.
    for fps in root.findall('.//footpathInfos'):
        for fp in list(fps):
            pts = fp.findall('itdPoint')
            if len(pts) < 2:
                fps.remove(fp)
                continue
            a_key = (pts[0].get('gid', ''), pts[0].get('area', ''))
            b_key = (pts[1].get('gid', ''), pts[1].get('area', ''))
            if a_key not in kept_keys or b_key not in kept_keys:
                fps.remove(fp)
                continue
            # Strip footpathPartInfos — parser only reads the duration attr.
            for child in list(fp):
                if child.tag != 'itdPoint':
                    fp.remove(child)

    return ET.tostring(root, encoding='unicode')


def main() -> int:
    if len(sys.argv) != 3:
        print('Usage: python3 -m build_interchanges.trim_fixture '
              '<input.xml> <output.xml>', file=sys.stderr)
        return 1
    input_path, output_path = sys.argv[1], sys.argv[2]
    with open(input_path, encoding='utf-8') as f:
        xml = f.read()
    trimmed = trim(xml)
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(trimmed)
    print(f'Trimmed {len(xml):,} bytes → {len(trimmed):,} bytes')
    return 0


if __name__ == '__main__':
    sys.exit(main())
