const rewire = require('rewire');
const {
    expect
} = require('chai');
const sinon = require('sinon');
const wisdom = rewire('../src/wisdom.js');
const isSlackAdapter = wisdom.__get__('isSlackAdapter');

describe('hubot-wisdom', () => {
    let robot;
    let hearListeners;
    let respondListeners;
    let reactionsAdd;
    let webClientToken;
    let clock;

    function buildRobot(adapterName) {
        hearListeners = [];
        respondListeners = [];
        return {
            adapterName,
            logger: {
                error: sinon.spy(),
                info: sinon.spy()
            },
            brain: {
                data: {}
            },
            hear(regex, cb) {
                hearListeners.push({ regex, cb });
            },
            respond(regex, cb) {
                respondListeners.push({ regex, cb });
            }
        };
    }

    function msgFor(match, extra) {
        return Object.assign({
            match,
            message: {
                user: {
                    name: 'alice'
                }
            },
            send: sinon.spy()
        }, extra);
    }

    // Run the hear listener the way hubot would: only if the text matches.
    async function hear(text, extra) {
        const { regex, cb } = hearListeners[0];
        const match = text.match(regex);
        if (!match) {
            return null;
        }
        const msg = msgFor(match, extra);
        await cb(msg);
        return msg;
    }

    function askForWisdom() {
        const { regex, cb } = respondListeners[0];
        const match = 'wisdom'.match(regex);
        const msg = msgFor(match);
        cb(msg);
        return msg;
    }

    beforeEach(() => {
        reactionsAdd = sinon.stub().resolves({ ok: true });
        webClientToken = undefined;
        wisdom.__set__('WebClient', function(token) {
            webClientToken = token;
            this.reactions = {
                add: reactionsAdd
            };
        });
        clock = sinon.useFakeTimers(new Date('2026-10-08T12:34:56.789Z').getTime());
        wisdom.__set__('Date', Date);
        robot = buildRobot('shell');
        wisdom(robot);
    });

    afterEach(() => {
        sinon.restore();
        clock.restore();
        delete process.env.HUBOT_WISDOM_INCLUDE_TIMESTAMP;
        delete process.env.HUBOT_SLACK_TOKEN;
        delete process.env.SLACK_BOT_TOKEN;
    });

    describe('module initialization', () => {
        it('registers one hear and one respond listener', () => {
            expect(hearListeners).to.have.lengthOf(1);
            expect(respondListeners).to.have.lengthOf(1);
        });
    });

    describe('quote pattern', () => {
        it('matches straight quotes with --', async () => {
            expect(await hear('"Ship it" -- Bob')).to.not.be.null;
        });

        it('matches curly quotes with an em dash', async () => {
            expect(await hear('“Ship it” — Bob')).to.not.be.null;
        });

        it('allows leading whitespace', async () => {
            expect(await hear('   "Ship it" -- Bob')).to.not.be.null;
        });

        it('ignores text without an attribution', async () => {
            expect(await hear('"Ship it"')).to.be.null;
        });

        it('ignores unquoted text', async () => {
            expect(await hear('Ship it -- Bob')).to.be.null;
        });

        it('ignores quotes that do not start the message', async () => {
            expect(await hear('he said "Ship it" -- Bob')).to.be.null;
        });
    });

    describe('storing quotes', () => {
        it('stores quote, author, submitter and timestamp', async () => {
            await hear('"Ship it" -- Bob');
            expect(robot.brain.data.quotes).to.deep.equal([{
                quote: '"Ship it"',
                author: 'Bob',
                user: 'alice',
                timestamp: '2026-10-08 12:34:56'
            }]);
        });

        it('appends to existing quotes', async () => {
            robot.brain.data.quotes = [{
                quote: '"Old"',
                author: 'Carol'
            }];
            await hear('"New" -- Dan');
            expect(robot.brain.data.quotes).to.have.lengthOf(2);
            expect(robot.brain.data.quotes[1].author).to.equal('Dan');
        });

        it('confirms with a message on non-Slack adapters', async () => {
            const msg = await hear('"Ship it" -- Bob');
            expect(msg.send.calledOnceWith('Quote added.')).to.be.true;
            expect(reactionsAdd.called).to.be.false;
        });
    });

    describe('on Slack', () => {
        beforeEach(() => {
            robot = buildRobot('@hubot-friends/hubot-slack');
            wisdom(robot);
        });

        it('reacts with :quote: instead of replying', async () => {
            process.env.HUBOT_SLACK_TOKEN = 'xoxb-test';
            const msg = await hear('"Ship it" -- Bob', {
                message: {
                    user: { name: 'alice' },
                    rawMessage: { ts: '123.456', channel: 'C123' }
                }
            });
            expect(webClientToken).to.equal('xoxb-test');
            expect(reactionsAdd.calledOnceWith({
                name: 'quote',
                channel: 'C123',
                timestamp: '123.456'
            })).to.be.true;
            expect(msg.send.called).to.be.false;
            expect(robot.brain.data.quotes).to.have.lengthOf(1);
        });

        it('falls back to SLACK_BOT_TOKEN', async () => {
            process.env.SLACK_BOT_TOKEN = 'xoxb-fallback';
            await hear('"Ship it" -- Bob', {
                message: {
                    user: { name: 'alice' },
                    rawMessage: { ts: '123.456', channel: 'C123' }
                }
            });
            expect(webClientToken).to.equal('xoxb-fallback');
        });

        it('logs an error when the reaction fails', async () => {
            reactionsAdd.rejects(new Error('missing_scope'));
            await hear('"Ship it" -- Bob', {
                message: {
                    user: { name: 'alice' },
                    rawMessage: { ts: '123.456', channel: 'C123' }
                }
            });
            expect(robot.logger.error.calledOnce).to.be.true;
            expect(robot.brain.data.quotes).to.have.lengthOf(1);
        });

        it('logs an error when ts or channel is missing', async () => {
            await hear('"Ship it" -- Bob');
            expect(reactionsAdd.called).to.be.false;
            expect(robot.logger.error.firstCall.args[0]).to.match(/ts or channel/);
        });
    });

    describe('isSlackAdapter', () => {
        it('detects robot.adapterName containing slack', () => {
            expect(isSlackAdapter({ adapterName: 'Slack' })).to.be.true;
        });

        it('falls back to robot.adapter.name', () => {
            expect(isSlackAdapter({ adapter: { name: 'hubot-slack' } })).to.be.true;
        });

        it('returns false for other adapters', () => {
            expect(isSlackAdapter({ adapterName: 'shell' })).to.be.false;
        });

        it('returns false when no adapter name is available', () => {
            expect(isSlackAdapter({})).to.be.false;
        });
    });

    describe('wisdom command', () => {
        it('asks to be taught when there are no quotes', () => {
            const msg = askForWisdom();
            expect(msg.send.calledOnceWith('I have no wisdom to share yet. Please teach me.')).to.be.true;
        });

        it('responds with a stored quote', () => {
            robot.brain.data.quotes = [{
                quote: '"Ship it"',
                author: 'Bob',
                timestamp: '2026-10-08 12:34:56'
            }];
            const msg = askForWisdom();
            expect(msg.send.calledOnceWith('"Ship it" -- Bob')).to.be.true;
        });

        it('includes the timestamp when HUBOT_WISDOM_INCLUDE_TIMESTAMP=true', () => {
            process.env.HUBOT_WISDOM_INCLUDE_TIMESTAMP = 'true';
            robot.brain.data.quotes = [{
                quote: '"Ship it"',
                author: 'Bob',
                timestamp: '2026-10-08 12:34:56'
            }];
            const msg = askForWisdom();
            expect(msg.send.calledOnceWith('"Ship it" -- Bob (added: 2026-10-08 12:34:56)')).to.be.true;
        });

        it('omits the timestamp for quotes stored before timestamps existed', () => {
            process.env.HUBOT_WISDOM_INCLUDE_TIMESTAMP = 'true';
            robot.brain.data.quotes = [{
                quote: '"Old"',
                author: 'Carol'
            }];
            const msg = askForWisdom();
            expect(msg.send.calledOnceWith('"Old" -- Carol')).to.be.true;
        });

        it('picks a quote at random', () => {
            sinon.stub(Math, 'random').returns(0.99);
            robot.brain.data.quotes = [
                { quote: '"First"', author: 'A' },
                { quote: '"Second"', author: 'B' }
            ];
            const msg = askForWisdom();
            expect(msg.send.calledOnceWith('"Second" -- B')).to.be.true;
        });
    });
});
