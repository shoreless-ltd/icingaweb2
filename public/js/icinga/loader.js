/**
 * Icinga.Loader
 *
 * This is where we take care of XHR requests, responses and failures.
 */
(function(Icinga, $) {

    'use strict';

    Icinga.Loader = function (icinga) {

        /**
         * YES, we need Icinga
         */
        this.icinga = icinga;

        /**
         * Our base url
         */
        this.baseUrl = icinga.config.baseUrl;

        this.failureNotice = null;

        this.exception = null;

        /**
         * Pending requests
         */
        this.requests = {};

        this.autorefreshEnabled = true;
    };

    Icinga.Loader.prototype = {

        initialize: function () {
            this.icinga.timer.register(this.autorefresh, this, 500);
        },

        /**
         * Load the given URL to the given target
         *
         * @param {string} url     URL to be loaded
         * @param {object} target  Target jQuery element
         * @param {object} data    Optional parameters, usually for POST requests
         * @param {string} method  HTTP method, default is 'GET'
         */
        loadUrl: function (url, $target, data, method, autorefresh) {
            var id = null;

            // Default method is GET
            if ('undefined' === typeof method) {
                method = 'GET';
            }
            if ('undefined' === typeof autorefresh) {
                autorefresh = false;
            }

            this.icinga.logger.debug('Loading ', url, ' to ', $target);

            // We should do better and ignore requests without target and/or id
            if (typeof $target !== 'undefined' && $target.attr('id')) {
                id = $target.attr('id');
            }

            // If we have a pending request for the same target...
            if (id in this.requests) {
                if (autorefresh) {
                    return false;
                }
                // ...ignore the new request if it is already pending with the same URL
                if (this.requests[id].url === url) {
                    this.icinga.logger.debug('Request to ', url, ' is already running for ', $target);
                    return this.requests[id];
                }
                // ...or abort the former request otherwise
                this.icinga.logger.debug(
                    'Aborting pending request loading ',
                    url,
                    ' to ',
                    $target
                );

                this.requests[id].abort();
            }

            // Not sure whether we need this Accept-header
            var headers = { 'X-Icinga-Accept': 'text/html' };

            // Ask for a new window id in case we don't already have one
            if (this.icinga.ui.hasWindowId()) {
                headers['X-Icinga-WindowId'] = this.icinga.ui.getWindowId();
            } else {
                headers['X-Icinga-WindowId'] = 'undefined';
            }

            var self = this;
            var req = $.ajax({
                type   : method,
                url    : url,
                data   : data,
                headers: headers,
                context: self
            });

            req.$target = $target;
            req.url = url;
            req.done(this.onResponse);
            req.fail(this.onFailure);
            req.complete(this.onComplete);
            req.historyTriggered = false;
            req.autorefresh = autorefresh;
            if (id) {
                this.requests[id] = req;
            }
            this.icinga.ui.refreshDebug();
            return req;
        },

        /**
         * Create an URL relative to the Icinga base Url, still unused
         *
         * @param {string} url Relative url
         */
        url: function (url) {
            if (typeof url === 'undefined') {
                return this.baseUrl;
            }
            return this.baseUrl + url;
        },

        stopPendingRequestsFor: function ($el) {
            var id;
            if (typeof $el !== 'undefined' || ! (id = $el.attr('id'))) {
                return;
            }

            if (id in this.requests) {
                this.requests[id].abort();
            }
        },

        filterAutorefreshingContainers: function () {
            return $(this).data('icingaRefresh') > 0;
        },

        autorefresh: function () {
            var self = this;
            if (self.autorefreshEnabled !== true) {
                return;
            }

            $('.container').filter(this.filterAutorefreshingContainers).each(function (idx, el) {
                var $el = $(el);
                var id = $el.attr('id');
                if (id in self.requests) {
                    self.icinga.logger.debug('No refresh, request pending for ', id);
                    return;
                }

                var interval = $el.data('icingaRefresh');
                var lastUpdate = $el.data('lastUpdate');

                if (typeof interval === 'undefined' || ! interval) {
                    self.icinga.logger.info('No interval, setting default', id);
                    interval = 10;
                }

                if (typeof lastUpdate === 'undefined' || ! lastUpdate) {
                    self.icinga.logger.info('No lastUpdate, setting one', id);
                    $el.data('lastUpdate',(new Date()).getTime());
                    return;
                }
                interval = interval * 1000;

                // TODO:
                if ((lastUpdate + interval) > (new Date()).getTime()) {
                    // self.icinga.logger.info(
                    //     'Skipping refresh',
                    //     id,
                    //     lastUpdate,
                    //     interval,
                    //     (new Date()).getTime()
                    // );
                    return;
                }

                if (self.loadUrl($el.data('icingaUrl'), $el, undefined, undefined, true) === false) {
                    self.icinga.logger.debug(
                        'NOT autorefreshing ' + id + ', even if ' + interval + ' ms passed. Request pending?'
                    );
                } else {
                    self.icinga.logger.debug(
                        'Autorefreshing ' + id + ' ' + interval + ' ms passed'
                    );
                }
                el = null;
            });
        },

        /**
         * Disable the autorefresh mechanism
         */
        disableAutorefresh: function () {
            this.autorefreshEnabled = false;
        },

        /**
         * Enable the autorefresh mechanism
         */
        enableAutorefresh: function () {
            this.autorefreshEnabled = true;
        },

        /**
         * Handle successful XHR response
         */
        onResponse: function (data, textStatus, req) {
            var self = this;
            if (this.failureNotice !== null) {
                this.failureNotice.remove();
                this.failureNotice = null;
            }

            if (this.exception !== null) {
                this.exception.remove();
                this.exception = null;
                req.$target.removeClass('impact');
            }

            var url = req.url;
            this.icinga.logger.debug(
                'Got response for ', req.$target, ', URL was ' + url
            );

            // div helps getting an XML tree
            var $resp = $('<div>' + req.responseText + '</div>');
            var active = false;
            var rendered = false;

            if (! req.autorefresh) {
                // TODO: Hook for response/url?
                var $forms = $('[action="' + this.icinga.utils.parseUrl(url).path + '"]');
                var $matches = $.merge($('[href="' + url + '"]'), $forms);
                $matches.each(function (idx, el) {
                    if ($(el).closest('#menu').length) {
                        $('#menu .active').removeClass('active');
                    } else if ($(el).closest('table.action').length) {
                        $(el).closest('table.action').find('.active').removeClass('active');
                    }
                });

                $matches.each(function (idx, el) {
                    var $el = $(el);
                    if ($el.closest('#menu').length) {
                        if ($el.is('form')) {
                            $('input', $el).addClass('active');
                        } else {
                            $el.closest('li').addClass('active');
                            $el.parents('li').addClass('active');
                        }
                        // Interrupt .each, only on menu item shall be active
                        return false;
                    } else if ($(el).closest('table.action').length) {
                        $el.addClass('active');
                    }
                });
            } else {
                // TODO: next container url
                active = $('[href].active', req.$target).attr('href');
            }

            var notifications = req.getResponseHeader('X-Icinga-Notification');
            if (notifications) {
                var parts = notifications.split(' ');
                this.createNotice(
                    parts.shift(),
                    parts.join(' ')
                );
            }

            //
            var target = req.getResponseHeader('X-Icinga-Container');
            var newBody = false;
            if (target) {
                if (target === 'ignore') {
                    return;
                }
                // If we change the target, oncomplete will fail to clean up
                // This fixes the problem, not using req.$target would be better
                delete this.requests[req.$target.attr('id')];

                req.$target = $('#' + target);
                newBody = true;
            }

            var moduleName = req.getResponseHeader('X-Icinga-Module');
            if (moduleName) {
                req.$target.addClass('icinga-module');
                req.$target.data('icingaModule', moduleName);
                req.$target.addClass('module-' + moduleName);
            } else {
                req.$target.removeClass('icinga-module');
                req.$target.removeData('icingaModule');
                req.$target.attr('class', 'container'); // TODO: remove module-$name
            }

            var cssreload = req.getResponseHeader('X-Icinga-CssReload');
            if (cssreload) {
                this.icinga.ui.reloadCss();
            }

            var title = req.getResponseHeader('X-Icinga-Title');
            if (title && req.$target.closest('.dashboard').length === 0) {
                this.icinga.ui.setTitle(title);
            }

            var refresh = req.getResponseHeader('X-Icinga-Refresh');
            if (refresh) {
                req.$target.data('icingaRefresh', refresh);
            } else {
                req.$target.removeData('lastUpdate');
            }

            // Set a window identifier if the server asks us to do so
            var windowId = req.getResponseHeader('X-Icinga-WindowId');
            if (windowId) {
                this.icinga.ui.setWindowId(windowId);
            }

            // Remove 'impact' class if there was such
            if (req.$target.hasClass('impact')) {
                req.$target.removeClass('impact');
            }

            // Handle search requests, still hardcoded.
            if (req.url.match(/^\/search/) &&
                req.$target.data('icingaUrl').match(/^\/search/) &&
                $('.dashboard', $resp).length > 0 &&
                $('.dashboard .container', req.$target).length > 0)
            {
                // TODO: We need dashboard pane and container identifiers (not ids)
                var targets = [];
                $('.dashboard .container', req.$target).each(function (idx, el) {
                    targets.push($(el));
                });

                var i = 0;
                // Searching for '.dashboard .container' in $resp doesn't dork?!
                $('.dashboard .container', $resp).each(function (idx, el) {
                    var $el = $(el);
                    if ($el.hasClass('dashboard')) {
                        return;
                    } else {

                    }
                    var url = $el.data('icingaUrl');
                    targets[i].data('icingaUrl', url);
                    var title = $('h1', $el).first();
                    $('h1', targets[i]).first().replaceWith(title);

                    self.loadUrl(url, targets[i]);
                    i++;
                });
                rendered = true;
            }

            req.$target.data('icingaUrl', req.url);

            // Update history when necessary. Don't do so for requests triggered
            // by history or autorefresh events
            if (! req.historyTriggered && ! req.autorefresh) {

                // We only want to care about top-level containers
                if (req.$target.parent().closest('.container').length === 0) {
                    this.icinga.history.pushCurrentState();
                }
            }


            /*
             * Replace SVG piecharts with jQuery-Sparkline
             */
            $('.inlinepie', $resp).each(function(){
                var   title = $(this).attr('title'),
                    style = $(this).attr('style'),
                    values = $(this).data('icinga-values');
                var html = '<div class="inlinepie" style="' + style + '" title="' + title + '">' + values + '</div>';
                $(this).replaceWith(html);
            });


            /* Should we try to fiddle with responses containing full HTML? */
            /*
            if ($('body', $resp).length) {
                req.responseText = $('script', $('body', $resp).html()).remove();
            }
            */
            /*

            var containers = [];

            $('.dashboard .container').each(function(idx, el) {
              urls.push($(el).data('icingaUrl'));
            });
            console.log(urls);
                  $('.container[data-icinga-refresh]').each(function(idx, el) {
                    var $el = $(el);
                    self.loadUrl($el.data('icingaUrl'), $el).autorefresh = true;
                    el = null;
                  });
            */

            if (rendered) {
                return;
            }

            // .html() removes outer div we added above
            this.renderContentToContainer($resp.html(), req.$target);
            if (url.match(/#/)) {
                this.icinga.ui.scrollContainerToAnchor(req.$target, url.split(/#/)[1]);
            }
            if (newBody) {
                this.icinga.ui.fixDebugVisibility().triggerWindowResize();
            }

            if (active) {
                $('[href="' + active + '"]', req.$target).addClass('active');
            }
        },

        /**
         * Regardless of whether a request succeeded of failed, clean up
         */
        onComplete: function (req, textStatus) {
            req.$target.data('lastUpdate', (new Date()).getTime());
            delete this.requests[req.$target.attr('id')];
            this.icinga.ui.fadeNotificationsAway();
            this.icinga.ui.refreshDebug();
        },

        /**
         * Handle failed XHR response
         */
        onFailure: function (req, textStatus, errorThrown) {
            var url = req.url;

            if (req.status === 500) {
                if (this.exception === null) {
                    req.$target.addClass('impact');

                    this.exception = this.createNotice(
                        'error',
                        $('h1', $(req.responseText)).first().html(),
                        true
                    );
                    this.icinga.ui.fixControls();
                }
            } else if (req.status > 0) {
                this.icinga.logger.error(req.status, errorThrown, req.responseText.slice(0, 100));
                this.renderContentToContainer(
                    req.responseText,
                    req.$target
                );

                // Header example:
                // Icinga.debug(req.getResponseHeader('X-Icinga-Redirect'));
            } else {
                if (errorThrown === 'abort') {
                    this.icinga.logger.info(
                        'Request to ' + url + ' has been aborted for ',
                        req.$target
                    );
                } else {
                    if (this.failureNotice === null) {
                        this.failureNotice = this.createNotice(
                            'error',
                            'The connection to the Icinga web server has been lost at ' +
                            this.icinga.utils.timeShort() +
                            '.',
                            true
                        );

                        this.icinga.ui.fixControls();
                    }

                    this.icinga.logger.error(
                        'Failed to contact web server loading ',
                        url,
                        ' for ',
                        req.$target
                    );
                }
            }
        },

        /**
         * Create a notification. Can be improved.
         */
        createNotice: function (severity, message, persist) {
            var c = severity;
            if (persist) {
                c += ' persist';
            }
            var $notice = $(
                '<li class="' + c + '">' + message + '</li>'
            ).appendTo($('#notifications'));
            this.icinga.ui.fixControls();
            return $notice;
        },

        /**
         * Smoothly render given HTML to given container
         */
        renderContentToContainer: function (content, $container) {
            // Disable all click events while rendering
            $('*').click(function (event) {
                event.stopImmediatePropagation();
                event.stopPropagation();
                event.preventDefault();
            });

            // Container update happens here
            var scrollPos = false;
            var containerId = $container.attr('id');
            if (typeof containerId !== 'undefined') {
                scrollPos = $container.scrollTop();
            }

            var origFocus = document.activeElement;
            var $content = $(content);
            if (false &&
                $('.dashboard', $content).length > 0 &&
                $('.dashboard', $container).length === 0
            ) {
                // $('.dashboard', $content)
                // $container.html(content);

            } else {
                if ($container.closest('.dashboard').length &&
                    ! $('h1', $content).length
                ) {
                    var title = $('h1', $container).first().detach();
                    $('h1', $content).first().detach();
                    $container.html(title).append(content);
                } else {
                    $container.html(content);
                }
            }

            if (scrollPos !== false) {
                $container.scrollTop(scrollPos);
            }
            if (origFocus) {
                origFocus.focus();
            }

            // TODO: this.icinga.events.refreshContainer(container);
            var icinga = this.icinga;
            icinga.events.applyHandlers($container);
            icinga.ui.initializeControls($container);
            icinga.ui.fixControls();

            // Re-enable all click events
            $('*').off('click');
        },

        /**
         * On shutdown we kill all pending requests
         */
        destroy: function() {
            $.each(this.requests, function(id, request) {
                request.abort();
            });
            this.icinga = null;
            this.requests = {};
        }

    };

}(Icinga, jQuery));
