from pathlib import Path

path = Path('test/bridge.test.ts')
source = path.read_text(encoding='utf-8')

for home, message_id in [
    ('c0c0c0c0-1111-4222-8333-000000000b71', 'prime-placement-71'),
    ('c0c0c0c0-1111-4222-8333-000000000b72', 'prime-placement-72'),
]:
    old = f"    await pair();\n    expect((await request('GET', `/activity?conversationId=${{home}}`)).status).toBe(200);\n"
    new = (
        "    await pair();\n"
        "    await request('POST', '/events', {\n"
        f"      body: {{ conversationId: home, events: [{{ kind: 'user_message', time: Date.now(), messageId: '{message_id}', text: 'prime is live' }}] }}\n"
        "    });\n"
        "    expect((await request('GET', `/activity?conversationId=${home}`)).status).toBe(200);\n"
    )
    if old not in source:
        raise SystemExit(f'fixture marker not found for {home}')
    source = source.replace(old, new, 1)

path.write_text(source, encoding='utf-8')
