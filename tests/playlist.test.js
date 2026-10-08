/* B-2 連續播放的邏輯測試
 *
 * 播放很麻煩的地方是「狀態」：中途按停止、某一個生字播不出來、清單是空的、
 * 換單元要停掉上一個。這些都用假的播放器驗，不需要真的喇叭。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Playlist = require('../public/js/playlist.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function entriesOf(count) {
    return Array.from({ length: count }, (unused, index) => ({ id: index + 1, headword: `word${index + 1}` }));
}

test('連續播放：依順序播完，onChange 會回報目前播到第幾個', async () => {
    const played = [];
    const seen = [];
    const reasons = [];
    const list = Playlist.create({
        playEntry: async (entry) => { played.push(entry.headword); await sleep(1); },
        onChange: (entry, index, total) => seen.push([entry.headword, index, total]),
        onDone: (reason) => reasons.push(reason),
        gapMs: 0
    });

    const reason = await list.run(entriesOf(3));
    assert.equal(reason, 'done');
    assert.deepEqual(played, ['word1', 'word2', 'word3']);
    assert.deepEqual(seen, [['word1', 0, 3], ['word2', 1, 3], ['word3', 2, 3]]);
    assert.deepEqual(reasons, ['done']);
});

test('連續播放：中途停止之後不會再播下一個，而且會叫停目前的播放', async () => {
    const played = [];
    let stopped = false;
    let controller = null;
    controller = Playlist.create({
        playEntry: async (entry) => {
            played.push(entry.headword);
            await sleep(30);                 /* 模擬「正在播」 */
            if (entry.headword === 'word1') controller.stop();
        },
        onStop: () => { stopped = true; },
        gapMs: 0
    });

    const reason = await controller.run(entriesOf(4));
    assert.equal(reason, 'stopped');
    assert.deepEqual(played, ['word1'], '按了停止就不該再播第二個');
    assert.equal(stopped, true, '停止時要通知畫面把目前的播放關掉');
    assert.equal(controller.state.running, false);
});

test('連續播放：某一個生字播不出來（裝置沒語音）不會讓整輪停掉', async () => {
    const played = [];
    const list = Playlist.create({
        playEntry: async (entry) => {
            played.push(entry.headword);
            if (entry.headword === 'word2') throw new Error('這個裝置沒有語音');
            await sleep(1);
        },
        gapMs: 0
    });

    const reason = await list.run(entriesOf(3));
    assert.equal(reason, 'done');
    assert.deepEqual(played, ['word1', 'word2', 'word3'], '第二個失敗還是要繼續第三個');
});

test('連續播放：空的清單要回報 empty，不會卡住', async () => {
    const reasons = [];
    const list = Playlist.create({ onDone: (reason) => reasons.push(reason) });
    assert.equal(await list.run([]), 'empty');
    assert.equal(await list.run(null), 'empty');
    assert.deepEqual(reasons, ['empty', 'empty']);
});

test('連續播放：每個生字之間會停一下（讓耳朵跟得上）', async () => {
    const stamps = [];
    const list = Playlist.create({
        playEntry: async () => { stamps.push(Date.now()); },
        gapMs: 40
    });
    const started = Date.now();
    await list.run(entriesOf(3));
    const total = Date.now() - started;
    assert.ok(total >= 70, `三個生字之間至少要停兩次（實際 ${total}ms）`);
});
