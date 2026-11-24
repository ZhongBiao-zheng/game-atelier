import csv
import json
from pathlib import Path

import pytest
from PIL import Image

from scripts.agent_eval.report import compare, machine_checks, write_report


def _row():
    return {
        'case_id': 'character', 'title': '三视图', 'chat_model': 'local/chat', 'surface': 'studio',
        'directory': 'character-chat', 'turns': [{'say': '<script>bad()</script>', 'attachments': ['a.png']}],
        'expect': {'images': 1, 'size': '64x32', 'ratio': '2:1', 'asks_user': False,
                   'skills': ['hero'], 'model_family': 'seedream', 'uses_all_attachments': True},
        'status': 'completed', 'final_reply': '好了', 'loaded_skills': ['hero'], 'available_skills': ['hero'],
        'attachments': [{'name': 'a.png', 'sha256': 'abc'}], 'elapsed_seconds': 1.25,
        'usage': {'input_tokens': 2, 'output_tokens': 3, 'total_cost_cny': 0.15},
        'validation_errors': 0, 'step_count': 1, 'steps': [], 'approvals': [],
        'generations': [{'kind': 'image', 'model': 'Seedream-5.0', 'turn_index': 1, 'requested_results': 1, 'status': 'done',
                         'prompt': '<img src=x>', 'params': {'size': '999x999'}, 'references': [{'sha256': 'abc'}],
                         'outputs': [{'kind': 'image', 'width': 999, 'height': 999, 'path': 'result.png'}]}],
    }


def _run(root):
    row = _row()
    dst = root / row['directory']
    dst.mkdir(parents=True)
    Image.new('RGB', (64, 32), 'purple').save(dst / 'result.png')
    write_report(root, [row])
    return json.loads((root / 'results.jsonl').read_text())


def test_report_measures_file_and_writes_offline_review_material(tmp_path):
    row = _run(tmp_path)
    assert {entry['status'] for entry in row['checks'].values()} == {'pass'}
    assert row['generations'][0]['outputs'][0]['width'] == 64
    page = (tmp_path / 'index.html').read_text()
    assert '&lt;script&gt;' in page and '<script>' not in page
    assert 'data:image/jpeg;base64,' in page and 'href="character-chat/result.png"' in page
    assert (tmp_path / 'character-chat/generation-01-prompt.txt').read_text() == '<img src=x>'
    assert json.loads((tmp_path / 'character-chat/transcript.json').read_text())['final_reply'] == '好了'
    with (tmp_path / 'scores.csv').open(encoding='utf-8-sig') as file:
        [score] = csv.DictReader(file)
    assert [score[key] for key in ('符合需求', '提示词质量', '画面质量', '备注')] == ['', '', '', '']


def test_compare_joins_by_case_and_model_and_reloads_scores(tmp_path):
    before, after = tmp_path / 'old', tmp_path / 'new'
    _run(before)
    _run(after)
    output = tmp_path / 'comparison'
    first = compare(before, after, output)
    assert '共同运行 1 组' in first and '100.0%' in first
    with (after / 'scores.csv').open('w', encoding='utf-8-sig', newline='') as f:
        writer = csv.writer(f)
        writer.writerows([['case_id', 'chat_model', '符合需求', '提示词质量', '画面质量', '备注'],
                          ['character', 'local/chat', 2, 3, 4, '透视错误']])
    assert '画面质量  |  —  |  4' in compare(before, after, output)
    page = (output / 'compare.html').read_text()
    assert '透视错误' in page and page.count('data:image/jpeg;base64,') == 2


def test_unknown_evidence_is_not_a_pass_and_failed_retries_are_per_turn():
    row = _row()
    row.update(available_skills=[], loaded_skills=[])
    row['generations'][0]['references'] = [{'sha256': None}]
    row['steps'] = [{'tool': 'run_generation', 'status': 'failed', 'turn_index': 1},
                    {'tool': 'run_generation', 'status': 'completed', 'turn_index': 1}]
    checks = machine_checks(row)
    assert checks['no_resubmit_after_failure']['status'] == 'fail'
    assert checks['skills']['status'] == checks['uses_all_attachments']['status'] == 'na'
    row['steps'][1]['turn_index'] = 2
    assert machine_checks(row)['no_resubmit_after_failure']['status'] == 'pass'
    row['status'] = 'not_applicable'
    assert {r['status'] for r in machine_checks(row).values()} == {'na'}


def test_report_extracts_video_contact_sheet_and_refuses_parent_paths(tmp_path):
    row = _row()
    dst = tmp_path / row['directory']
    dst.mkdir()
    (dst / 'clip.mp4').write_bytes((Path(__file__).parent / 'fixtures/video/h264-24f.mp4').read_bytes())
    row['generations'][0].update(kind='video', outputs=[{'kind': 'video', 'path': 'clip.mp4'}])
    write_report(tmp_path, [row])
    [item] = row['generations'][0]['outputs']
    with Image.open(dst / item['preview']) as sheet:
        assert min(sheet.size) > 0 and item['width'] > 0
    row['directory'] = '../parent'
    with pytest.raises(ValueError, match='超出结果目录'):
        write_report(tmp_path, [row])


def test_two_turn_edit_grades_each_response_and_source_hash_and_compares_turns(tmp_path):
    row = _row()
    row.update(case_id='10-edit-two-turns', turns=[
        {'say': '画蓝色披风', 'expect': {'images': 1, 'asks_user': False}},
        {'say': '把披风改成红色', 'expect': {'images': 1, 'uses_previous_result': True,
                                             'skills': ['usecase-edit']}},
    ], expect={'asks_user': False}, human_check=['其余保持不变 <核对>'],
        available_skills=['usecase-edit'], turn_outcomes=[
            {'turn_index': 1, 'final_reply': '好了', 'loaded_skills': []},
            {'turn_index': 2, 'final_reply': '已修改', 'loaded_skills': ['usecase-edit']},
        ])
    first = row['generations'][0]
    first['outputs'][0]['source_sha256'] = 'original-blue-cloak'
    second = {**first, 'turn_index': 2, 'references': [{'source': 'copied.png', 'sha256': 'original-blue-cloak'}],
              'outputs': [{'kind': 'image', 'path': 'edit.png', 'source_sha256': 'original-red-cloak'}]}
    row['generations'].append(second)
    for root in ('old', 'new'):
        directory = tmp_path / root / row['directory']
        directory.mkdir(parents=True)
        for path, color in [('result.png', 'blue'), ('edit.png', 'red')]:
            Image.new('RGB', (64, 32), color).save(directory / path)
        if root == 'new':
            # A new drawing with the same filename is not an edit reference.
            second['references'] = [{'source': 'result.png', 'sha256': 'unrelated'}]
        write_report(tmp_path / root, [row])
        checks = row['checks']
        assert checks['1.images']['status'] == checks['2.images']['status'] == 'pass'
        assert checks['2.uses_previous_result']['status'] == ('pass' if root == 'old' else 'fail')
        assert checks['2.skills']['status'] == checks['2.asks_user']['status'] == 'pass'
        assert '其余保持不变 &lt;核对&gt;' in (tmp_path / root / 'index.html').read_text()
    plain = compare(tmp_path / 'old', tmp_path / 'new', tmp_path)
    assert '第 2 轮 · 沿用上一轮结果  |  通过  |  不通过' in plain
    assert '第 1 轮 · 图片张数  |  通过  |  通过' in plain
    second['references'][0]['sha256'] = None
    assert machine_checks(row)['2.uses_previous_result']['status'] == 'na'
    row['turn_outcomes'].pop()
    assert all(c['status'] == 'na' for key, c in machine_checks(row).items() if key.startswith('2.'))


def test_video_case_counts_decodes_duration_and_orientation(tmp_path):
    import cv2
    import numpy as np

    row = _row()
    row.update(case_id='12-video-character-action', expect={'videos': 1, 'duration_s': 5,
               'orientation': 'portrait', 'uses_all_attachments': True, 'asks_user': False})
    directory = tmp_path / row['directory']
    directory.mkdir()
    path = directory / 'clip.avi'
    stream = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*'MJPG'), 5, (32, 64))
    try:
        for n in range(25):
            stream.write(np.full((64, 32, 3), n, dtype=np.uint8))
    finally:
        stream.release()
    row['generations'][0].update(kind='video', params={'duration': 17}, outputs=[{'kind': 'video', 'path': path.name}])
    write_report(tmp_path, [row])
    assert {v['status'] for v in row['checks'].values()} == {'pass'}
    [item] = row['generations'][0]['outputs']
    assert (item['duration_s'], item['width'], item['height']) == (5.0, 32, 64)
    row['expect'].update(duration_s=17, orientation='landscape')
    assert machine_checks(row)['duration_s']['status'] == machine_checks(row)['orientation']['status'] == 'fail'
    item['duration_s'] = None
    assert machine_checks(row)['duration_s']['status'] == 'na'


@pytest.mark.parametrize('connected,verdict', [(True, 'pass'), (False, 'fail'), (None, 'na')])
def test_canvas_grades_observed_result_connections(connected, verdict):
    row = _row()
    row.update(case_id='13-canvas-turnaround', surface='canvas', expect={'on_canvas': True})
    row['generations'][0]['on_canvas'] = connected
    assert machine_checks(row)['on_canvas']['status'] == verdict
