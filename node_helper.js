/* Magic Mirror
 * Module: MMM-Reddit
 *
 * By kjb085 https://github.com/kjb085/MMM-Reddit
 */
const https = require('https');
const urlLib = require('url');
const NodeHelper = require('node_helper');

module.exports = NodeHelper.create({

    /**
     * Base url for all requests
     * @type {String}
     */
    baseUrl: 'https://www.reddit.com/',

    /**
     * List of image qualities in ascending order
     * @type {Array}
     */
    qualityIndex: [
        'low',
        'mid',
        'mid-high',
        'high',
    ],

    /**
     * Log the the helper has started
     *
     * @return {void}
     */
    start () {
        console.log(`Starting module helper: ${this.name}`);
    },

    /**
     * Handle frontend notification by setting config and initializing reddit request
     *
     * @param  {String} notification
     * @param  {Object} payload
     * @return {void}
     */
    socketNotificationReceived (notification, payload) {
        if (notification === 'REDDIT_CONFIG') {
            this.config = payload.config;
            this.getData();
        }
    },

    sendData (obj) {
        this.sendSocketNotification('REDDIT_POSTS', obj);
    },

    /**
     * Identify ourselves to reddit; requests without a User-Agent are rejected
     * @type {String}
     */
    userAgent: 'MagicMirror:MMM-Reddit:1.1 (self-hosted smart mirror)',

    /**
     * GET a URL and resolve with {statusCode, body}, following redirects
     *
     * @param  {String} url
     * @param  {Number} redirects
     * @return {Promise}
     */
    fetch (url, redirects = 3) {
        return new Promise((resolve, reject) => {
            let options = Object.assign(urlLib.parse(url), { headers: { 'User-Agent': this.userAgent } });

            https.get(options, (response) => {
                let body = '';

                if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects > 0) {
                    response.resume();
                    resolve(this.fetch(urlLib.resolve(url, response.headers.location), redirects - 1));
                    return;
                }

                response.setEncoding('utf8');
                response.on('data', (chunk) => { body += chunk; });
                response.on('end', () => resolve({ statusCode: response.statusCode, body: body }));
            }).on('error', reject);
        });
    },

    /**
     * Make request to reddit and send posts back to MM frontend.
     * Tries the JSON listing first; reddit now blocks most anonymous JSON
     * requests, so fall back to the public RSS feed.
     *
     * @return {void}
     */
    async getData () {
        let url = this.getUrl(this.config),
            response;

        try {
            response = await this.fetch(url);

            if (response.statusCode === 200) {
                this.handleJson(JSON.parse(response.body));
                return;
            }

            response = await this.fetch(url.replace('/.json?raw_json=1&', '/.rss?'));

            if (response.statusCode === 200) {
                this.handleRss(response.body);
                return;
            }

            this.sendError('Request status code: ' + response.statusCode);
        } catch (error) {
            this.sendError('Request failed: ' + error.message);
        }
    },

    /**
     * Build posts from a reddit JSON listing
     *
     * @param  {Object} body
     * @return {void}
     */
    handleJson (body) {
        let posts = [];

        if (typeof body.data === "undefined") {
            this.sendError(['Invalid response body', body]);
            return;
        }

        if (typeof body.data.children === "undefined") {
            this.sendError('No posts returned. Ensure the subreddit name is spelled correctly. ' +
                'Private subreddits are also inaccessible');
            return;
        }

        body.data.children.forEach((post) => {
            let temp = {};

            temp.title = this.formatTitle(post.data.title);
            temp.score = post.data.score;
            temp.thumbnail = post.data.thumbnail;
            temp.src = this.getImageUrl(post.data.preview, post.data.thumbnail),
            temp.gilded = post.data.gilded;
            temp.num_comments = post.data.num_comments;
            temp.subreddit = post.data.subreddit;
            temp.author = post.data.author;

            // Skip image posts that do not have images
            if (this.config.displayType !== 'image' || temp.src !== null) {
                posts.push(temp);
            }
        });

        this.sendData({posts: posts});
    },

    /**
     * Build posts from a reddit Atom/RSS feed. The feed carries no score,
     * comment count or gilding, so those fields are left blank.
     *
     * @param  {String} xml
     * @return {void}
     */
    handleRss (xml) {
        let entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [],
            posts = [];

        entries.slice(0, this.config.count).forEach((entry) => {
            let pick = (regex) => { let m = entry.match(regex); return m ? this.decodeEntities(m[1]) : ''; },
                thumbnail = pick(/<media:thumbnail url="([^"]+)"/),
                image = pick(/&lt;a href=&quot;(https:\/\/i\.redd\.it\/[^&]+)&quot;/) ||
                    pick(/<link href="(https:\/\/i\.redd\.it\/[^"]+)"/),
                temp = {};

            temp.title = this.formatTitle(pick(/<title>([\s\S]*?)<\/title>/));
            temp.score = '';
            temp.thumbnail = thumbnail || 'default';
            temp.src = image || null;
            temp.gilded = 0;
            temp.num_comments = '';
            temp.subreddit = pick(/<category term="([^"]+)"/);
            temp.author = pick(/<author><name>\/u\/([^<]+)<\/name>/);

            if (this.config.displayType !== 'image' || temp.src !== null) {
                posts.push(temp);
            }
        });

        if (posts.length === 0) {
            this.sendError('No posts returned. Ensure the subreddit name is spelled correctly. ' +
                'Private subreddits are also inaccessible');
            return;
        }

        this.sendData({posts: posts});
    },

    /**
     * Decode the XML/HTML entities reddit uses in feed text
     *
     * @param  {String} text
     * @return {String}
     */
    decodeEntities (text) {
        return text
            .replace(/&#(\d+);/g, (m, code) => String.fromCharCode(code))
            .replace(/&#x([0-9a-f]+);/gi, (m, code) => String.fromCharCode(parseInt(code, 16)))
            .replace(/&quot;/g, '"')
            .replace(/&#39;|&apos;/g, "'")
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&');
    },

    /**
     * Get reddit URL based on user configuration
     *
     * @param  {Object} config
     * @return {String}
     */
    getUrl (config) {
        let url = this.baseUrl,
            subreddit = this.formatSubreddit(config.subreddit),
            type = config.type,
            count = config.count;

        if (subreddit !== '' && subreddit !== 'frontpage') {
            url += 'r/' + subreddit + '/';
        }

        return url + type + '/.json?raw_json=1&limit=' + count;
    },

    /**
     * If mutliple subreddits configured, stringify for URL use
     *
     * @param  {String|Array} subreddit
     * @return {String}
     */
    formatSubreddit (subreddit) {
        if (Array.isArray(subreddit)) {
            subreddit = subreddit.join('+');
        }

        return subreddit;
    },

    /**
     * Format the title to return to front end
     *
     * @param  {Object} post
     * @return {String}
     */
    formatTitle (title) {
        let replacements = this.config.titleReplacements,
            limit = this.config.characterLimit,
            originalLength = title.length;

        replacements.forEach((modifier) => {
            let caseSensitive = typeof modifier.caseSensitive !== 'undefined' ? modifier.caseSensitive : true,
                caseFlag = caseSensitive ? '' : 'i',
                search = new RegExp(modifier.toReplace, 'g' + caseFlag),
                replacement = modifier.replacement;

            title = title.replace(search, replacement);
        });

        if (limit !== null) {
            title = title.slice(0, limit).trim();

            if (title.length !== originalLength) {
                title += '...';
            }
        }

        return title;
    },

    /**
     * If applicable, get the URL for the resolution designated by the user
     *
     * @param  {Object} preview
     * @param  {String} thumbnail
     * @return {String}
     */
    getImageUrl (preview, thumbnail) {
        if (this.skipNonImagePost(preview, thumbnail)) {
            return null;
        }

        let allPostImages = this.getAllImages(preview.images[0]),
            imageCount = allPostImages.length,
            qualityIndex = this.qualityIndex.indexOf(this.config.imageQuality),
            qualityPercent = qualityIndex / 4,
            imageIndex;

        if (imageCount > 5) {
            imageIndex = Math.round(qualityPercent * imageCount);
        } else {
            imageIndex = Math.floor(qualityPercent * imageCount);
        }

        return allPostImages[imageIndex].url;
    },

    /**
     * Determine if the current post is not an image post
     *
     * @param  {Object} preview
     * @param  {String} thumbnail
     * @return {Boolean}
     */
    skipNonImagePost (preview, thumbnail) {
        let previewUndefined = typeof preview === "undefined",
            nonImageThumbnail = thumbnail.indexOf('http') === -1,
            hasImages, firstImageHasSource;

        if (!previewUndefined && !nonImageThumbnail) {
            hasImages = preview.hasOwnProperty('images');

            if (hasImages) {
                firstImageHasSource = preview.images[0].hasOwnProperty('source');

                if (firstImageHasSource) {
                    return false;
                }
            }
        }

        return true;
    },

    /**
     * Get set of all image resolutions
     *
     * @param  {Object} imageObj
     * @return {Array}
     */
    getAllImages (imageObj) {
        let imageSet = imageObj.resolutions,
            lastImage = imageSet.pop(),
            lastIsSource = lastImage.width === imageObj.source.width &&
                lastImage.height === imageObj.source.height;

        imageSet.push(lastImage);

        if (!lastIsSource) {
            imageSet.push(imageObj.source);
        }

        return imageSet;
    },

    /**
     * Send an error to the frontend
     *
     * @param  {String} error
     * @return {void}
     */
    sendError (error) {
        console.log(error);
        this.sendSocketNotification('REDDIT_POSTS_ERROR', { message: error });
    },
});
