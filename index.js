/**
 * This is an example of a basic node.js script that performs
 * the Authorization Code oAuth2 flow to authenticate against
 * the Spotify Accounts.
 *
 * For more information, read
 * https://developer.spotify.com/web-api/authorization-guide/#authorization_code_flow
 */

var express = require('express'); // Express web server framework
var request = require('request'); // "Request" library
var cors = require('cors');
var _ = require('lodash');
var querystring = require('querystring');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
require('dotenv').config();

const accessTokenUserIdMap = {};
const {GoogleSpreadsheet} = require('google-spreadsheet');
const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);
// use service account creds
doc.useServiceAccountAuth(require(process.env.GOOGLE_SERVICE_ACCOUNT_JSON));
doc.loadInfo().then(async () => {

    var sheet = doc.sheetsByIndex[0];
    var rows = await sheet.getRows();

    setInterval(async () => {
        rows = await sheet.getRows();
    }, 2000);

    var client_id = process.env.SPOTIFY_CLIENT_ID; // Your client id
    var client_secret = process.env.SPOTIFY_CLIENT_SECRET; // Your secret
    var redirect_uri = process.env.HOSTNAME + '/callback'; // Your redirect uri

    /**
     * Generates a random string containing numbers and letters
     * @param  {number} length The length of the string
     * @return {string} The generated string
     */
    var generateRandomString = function (length) {
        var text = '';
        var possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

        for (var i = 0; i < length; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    };

    var stateKey = 'spotify_auth_state';

    var app = express();

    // parse application/json
    app.use(bodyParser.json());

    app.use(express.static(__dirname + '/public'))
        .use(cors())
        .use(cookieParser());

    app.get('/login', function (req, res) {

        var state = generateRandomString(16);
        res.cookie(stateKey, state);

        // your application requests authorization
        var scope = 'user-read-currently-playing';
        res.redirect('https://accounts.spotify.com/authorize?' +
            querystring.stringify({
                response_type: 'code',
                client_id: client_id,
                scope: scope,
                redirect_uri: redirect_uri,
                state: state
            }));
    });

    app.get('/callback', function (req, res) {

        // your application requests refresh and access tokens
        // after checking the state parameter

        var code = req.query.code || null;
        var state = req.query.state || null;
        var storedState = req.cookies ? req.cookies[stateKey] : null;

        if (state === null || state !== storedState) {
            res.redirect('/#' +
                querystring.stringify({
                    error: 'state_mismatch'
                }));
        } else {
            res.clearCookie(stateKey);
            var authOptions = {
                url: 'https://accounts.spotify.com/api/token',
                form: {
                    code: code,
                    redirect_uri: redirect_uri,
                    grant_type: 'authorization_code'
                },
                headers: {
                    'Authorization': 'Basic ' + (new Buffer(client_id + ':' + client_secret).toString('base64'))
                },
                json: true
            };

            request.post(authOptions, function (error, response, body) {
                if (!error && response.statusCode === 200) {

                    var access_token = body.access_token,
                        refresh_token = body.refresh_token;

                    var options = {
                        url: 'https://api.spotify.com/v1/me',
                        headers: {'Authorization': 'Bearer ' + access_token},
                        json: true
                    };

                    // use the access token to access the Spotify Web API
                    request.get(options, function (error, response, body) {
                        if (body.id) {
                            accessTokenUserIdMap[access_token] = body.id;
                        }
                        console.log(body, accessTokenUserIdMap);
                    });

                    // we can also pass the token to the browser to make requests from there
                    res.redirect('/#' +
                        querystring.stringify({
                            access_token: access_token,
                            refresh_token: refresh_token
                        }));
                } else {
                    res.redirect('/#' +
                        querystring.stringify({
                            error: 'invalid_token'
                        }));
                }
            });
        }
    });

    async function getUser(access_token) {
        var options = {
            url: 'https://api.spotify.com/v1/me',
            headers: {'Authorization': 'Bearer ' + access_token},
            json: true
        };

        // use the access token to access the Spotify Web API
        return new Promise(resolve => {
            request.get(options, function (error, response, body) {
                if (body.id) {
                    accessTokenUserIdMap[access_token] = body.id;
                }
                resolve(body);
            });
        });
    }

    app.post('/tags', async function (req, res) {
        var access_token = (req.headers.authorization || "").replace('Bearer ', '');
        if (!access_token) {
            res.send('error');
            return;
        }
        var song = req.body.song || null;
        var tag = req.body.tag || null;
        if (!(access_token in accessTokenUserIdMap)) {
            await getUser(access_token);
        }
        const userId = accessTokenUserIdMap[access_token];
        await sheet.addRow({user: userId, song: song, tag: tag});
        res.send('OK');
    });

    app.get('/tags/:song_id', async function (req, res) {
        var access_token = (req.headers.authorization || "").replace('Bearer ', '');
        if (!access_token) {
            res.send('error');
            return;
        }
        var song = req.params.song_id;
        if (!(access_token in accessTokenUserIdMap)) {
            await getUser(access_token);
        }
        const userId = accessTokenUserIdMap[access_token];

        res.json(_.filter(rows, (row) => {
            return row.user === userId && row.song === song;
        }).map((row) => {
            return row.tag;
        }));
    });

    app.get('/tags', async function (req, res) {
        var access_token = (req.headers.authorization || "").replace('Bearer ', '');
        if (!access_token) {
            res.send('error');
            return;
        }
        if (!(access_token in accessTokenUserIdMap)) {
            await getUser(access_token);
        }
        const userId = accessTokenUserIdMap[access_token];

        res.json(_.uniq(_.filter(rows, (row) => {
            return row.user === userId;
        }).map((row) => {
            return row.tag;
        })));
    });

    app.get('/refresh_token', function (req, res) {

        // requesting access token from refresh token
        var refresh_token = req.query.refresh_token;
        var authOptions = {
            url: 'https://accounts.spotify.com/api/token',
            headers: {'Authorization': 'Basic ' + (new Buffer(client_id + ':' + client_secret).toString('base64'))},
            form: {
                grant_type: 'refresh_token',
                refresh_token: refresh_token
            },
            json: true
        };

        request.post(authOptions, function (error, response, body) {
            if (!error && response.statusCode === 200) {
                var access_token = body.access_token;
                res.send({
                    'access_token': access_token
                });
            }
        });
    });

    console.log('Listening on ' + process.env.PORT);
    app.listen(process.env.PORT);
});

