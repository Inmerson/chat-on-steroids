from pathlib import Path

path = Path('test/bridge.test.ts')
source = path.read_text(encoding='utf-8')

for home, message_id in [
    ('c0c0c0c0-1111-4222-8333-000000000b71', 'prime-placement-71'),
    ('c0c0c0c0-1111-4222-8333-000000000b72', 'prime-placement-72'),
]:
    home_line = f"const home = '{home}';"
    home_at = source.index(home_line)
    pair_at = source.index('await pair();', home_at)
    line_start = source.rfind('\n', 0, pair_at) + 1
    indent = source[line_start:pair_at]
    activity = f"{indent}expect((await request('GET', `/activity?conversationId=${{home}}`)).status).toBe(200);\n"
    activity_at = source.index(activity, pair_at)
    insertion_at = activity_at
    recorded = (
        f"{indent}await request('POST', '/events', {{\n"
        f"{indent}  body: {{ conversationId: home, events: [{{ kind: 'user_message', time: Date.now(), messageId: '{message_id}', text: 'prime is live' }}] }}\n"
        f"{indent}}});\n"
    )
    if recorded in source[home_at:activity_at + len(activity)]:
        continue
    source = source[:insertion_at] + recorded + source[insertion_at:]

path.write_text(source, encoding='utf-8')
