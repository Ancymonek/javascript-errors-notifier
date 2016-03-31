﻿function htmlentities(str) {
	var div = document.createElement('div');
	div.appendChild(document.createTextNode(str));
	return div.innerHTML;
}

function formatStackForPopup(stack) {
	var lines = [];
	for(var i in stack) {
		var call = stack[i];
		lines.push((stack.length > 1 ? '&nbsp;#' + call.num + ' ' : '') + (localStorage['linkViewSource']
					? ('<a href="view-source:' + call.url + (call.line ? '#' + call.line : '') + '" target="_blank">' + call.url + (call.line ? ':' + call.line : '') + '</a>')
					: (call.url + (call.line ? ':' + call.line : ''))
			) + ' ' + call.method);
	}
	return lines.join('<br/>');
}

function getBaseHostByUrl(url) {
	var localUrlRegexp = /(file:\/\/.*)|(:\/\/[^.:]+([\/?]|$))/; // file://
	var rootHostRegexp = /:\/\/(([\w-]+\.\w+)|(\d+\.\d+\.\d+\.\d+)|(\[[\w:]+\]))([\/?:]|$)/; // domain.com | IPv4 | IPv6
	var subDomainRegexp = /:\/\/.*\.([\w-]+\.\w+)([\/?:]|$)/; // sub.domain.com
	return localUrlRegexp.exec(url) ? 'localhost' : (rootHostRegexp.exec(url) || subDomainRegexp.exec(url))[1];
}

function initDefaultOptions() {
	var optionsValues = {
		showIcon: true,
		ignore404others: true,
		ignoreBlockedByClient: true
	};
	for(var option in optionsValues) {
		if(typeof localStorage[option] == 'undefined') {
			localStorage[option] = optionsValues[option] ? 1 : '';
		}
	}
}
initDefaultOptions();

// Ignore net::ERR_BLOCKED_BY_CLIENT initiated by AdPlus & etc
var ignoredUrlsHashes = {};
var ignoredUrlsLimit = 100;

function isUrlIgnoredByType(url) {
	if(!url.indexOf('chrome-extension://')) { // ignore Google Chrome extensions 404 errors
		return true;
	}
	var ext = url.split('.').pop().split(/\#|\?/)[0].toLowerCase();
	if(ext == 'js') {
		return localStorage['ignore404js'];
	}
	if(ext == 'css') {
		return localStorage['ignore404css'];
	}
	return localStorage['ignore404others'];
}

function getIgnoredUrlHash(url) {
	return url.replace(/\d+/g, '');
}

chrome.webRequest.onErrorOccurred.addListener(function(e) {
	if(localStorage['ignoreBlockedByClient'] && e.error == 'net::ERR_BLOCKED_BY_CLIENT') {
		var url = getIgnoredUrlHash(e.url);
		if(!isUrlIgnoredByType(url)) {
			if(ignoredUrlsHashes[url]) { // move url in the end of list
				delete ignoredUrlsHashes[url];
			}
			ignoredUrlsHashes[url] = true;
			var ignoredUrlsArray = Object.keys(ignoredUrlsHashes);
			if(ignoredUrlsArray.length > ignoredUrlsLimit) {
				delete ignoredUrlsHashes[ignoredUrlsArray[0]];
			}
		}
	}
}, {urls: ["<all_urls>"]});

function handleInitRequest(data, sender, sendResponse) {
	var tabHost = getBaseHostByUrl(data.url);
	chrome.tabs.get(sender.tab.id, function callback() { // mute closed tab error
		if(chrome.runtime.lastError) {
			return;
		}
		chrome.pageAction.setTitle({
			tabId: sender.tab.id,
			title: 'No errors on this page'
		});
		chrome.pageAction.setPopup({
			tabId: sender.tab.id,
			popup: 'popup.html?host=' + encodeURIComponent(tabHost) + '&tabId=' + sender.tab.id
		});
		chrome.pageAction.show(sender.tab.id);
	});
	sendResponse({
		showIcon: typeof localStorage['icon_' + tabHost] != 'undefined' ? localStorage['icon_' + tabHost] : localStorage['showIcon'],
		showPopup: typeof localStorage['popup_' + tabHost] != 'undefined' ? localStorage['popup_' + tabHost] : localStorage['showPopup'],
		showPopupOnMouseOver: localStorage['showPopupOnMouseOver']

	});
}

function handleErrorsRequest(data, sender, sendResponse) {
	var popupErrors = [];
	var stackLineRegExp = new RegExp('^(.*?)\\(?((https?|file)://.*?)(\\)|$)');
	var tabHost = getBaseHostByUrl(data.url);

	for(var i in data.errors) {
		var error = data.errors[i];
		var errorHost = getBaseHostByUrl(error.url);
		if(localStorage['ignoreExternal'] && errorHost != tabHost) {
			continue;
		}
		if(error.is404) {
			if(ignoredUrlsHashes[getIgnoredUrlHash(error.url)] || isUrlIgnoredByType(error.url)) {
				delete data.errors[i];
				continue;
			}
			error.type = 'File not found';
			error.text = error.url;
			popupErrors.unshift('File not found: ' + htmlentities(error.url));
		}
		else {
			error.text = error.text.replace(/^Uncaught /g, '');

			var errorHtml = localStorage['linkStackOverflow']
				? '<a target="_blank" href="http://www.google.com/search?q=' + encodeURIComponent(htmlentities(error.text)) + '%20site%3Astackoverflow.com" id="">' + htmlentities(error.text) + '</a>'
				: htmlentities(error.text);

			var m = new RegExp('^(\\w+):\s*(.+)').exec(error.text);
			error.type = m ? m[1] : 'Uncaught Error';

			if(localStorage['showColumn'] && error.line && error.col) {
				error.line = error.line + ':' + error.col;
			}

			if(localStorage['showTrace'] && error.stack) {
				var lines = error.stack.replace(/\n\s*at\s+/g, '\n').split('\n');
				lines.shift();
				for(var ii in lines) {
					var m = stackLineRegExp.exec(lines[ii]);
					var url = m ? m[2] : lines[ii];
					var subUrl = /^(.*?):([\d:]+)/.exec(url);
					lines[ii] = {
						num: lines.length - ii,
						url: subUrl ? subUrl[1] : url,
						line: subUrl ? subUrl[2] : null,
						method: (m && m[1].trim() ? m[1].trim() + '()' : '')
					};
				}
				errorHtml += '<br/>' + formatStackForPopup(lines);
			}
			else {
				var url = error.url + (error.line ? ':' + error.line : '');
				errorHtml += '<br/>' + (localStorage['linkViewSource']
						? '<a href="view-source:' + error.url + (error.line ? '#' + error.line : '') + '" target="_blank">' + url + '</a>'
						: url);
			}
			popupErrors.push(errorHtml);
		}
	}

	if(!popupErrors.length) {
		return;
	}

	chrome.tabs.get(sender.tab.id, function callback() { // mute closed tab error
		if(chrome.runtime.lastError) {
			return;
		}

		chrome.pageAction.setTitle({
			tabId: sender.tab.id,
			title: 'There are some errors on this page. Click to see details.'
		});

		chrome.pageAction.setIcon({
			tabId: sender.tab.id,
			path: {
				"19": "img/error_19.png",
				"38": "img/error_38.png"
			}
		});

		var popupUri = 'popup.html?errors=' + encodeURIComponent(popupErrors.join('<br/><br/>')) + '&host=' + encodeURIComponent(tabHost) + '&tabId=' + sender.tab.id;

		chrome.pageAction.setPopup({
			tabId: sender.tab.id,
			popup: popupUri
		});

		chrome.pageAction.show(sender.tab.id);

		sendResponse(chrome.extension.getURL(popupUri));
	});
}

chrome.runtime.onMessage.addListener(function(data, sender, sendResponse) {
	if(data._initPage) {
		handleInitRequest(data, sender, sendResponse);
	}
	else if(data._errors) {
		handleErrorsRequest(data, sender, sendResponse);
	}
	return true;
});
