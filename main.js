var BOOKMARKS_BAR_NAME = 'Bookmarks bar'
var SAVED_GROUPS_FOLDER_NAME = 'Saved Groups'

// We have listeners on changes on the bookmarks (to update the ctx menu upon changesfrom outside the extension).
// If we create a bookmark from inside the extension, we don't want the listener to be called.
// Sadley, bookmarks.EVENT.removeListeners() has no effect, so we have a refcount of the extensions bookmarks
// creation, and only if it's 0, meaning the listener's callback isn't triggered by the extension, we preform
// the callback
var createRef = 0;

async function createBookmark(createDetails) {
    createRef++;
    return chrome.bookmarks.create(createDetails);
}

async function saveGroupTabs(groupId, groupBookmarkId) {
    // Get all bookmarks in the folder
    let bm = await chrome.bookmarks.getSubTree(groupBookmarkId);

    // Query the tabs with the same group id
    let tabs = await chrome.tabs.query({
        "groupId": groupId
    });

    for (const tab of tabs) {
        if (!tab.url) {
            continue;
        }

        // If the url isn't bookmarked already, save it
        if (searchBookmarks(bm, null, tab.url) == '0') {
            // And bookmark them
            console.debug(`Bookmarking tab ${tab.title} @ ${tab.url}`);
            createBookmark({
                'parentId': groupBookmarkId,
                'title': tab.title,
                'url': tab.url,
            });
        } else {
            console.debug(`A bookmark with url ${tab.url} already exists`);
        }
    }
}

// Bookmark has a search method but it searches all bookmarks, and we want sometimes to search only in a specific folder
function searchBookmarks(bookmarks, title, url) {
    let id = 0;
    console.debug(`Looking for bookmark: ${title} | ${url}`);

    recursiveSearch(bookmarks, title, url);

    // Save the new id, only if the id isn't set already (which means we've already found the id)
    function recursiveSearch(bookmarks, title, url) {
        bookmarks.forEach(function (bm) {
            //console.debug(`bookmark: ${bm.title} (${bm.id})`);
            if (!id && bm.title == title) {
                console.debug(`Found bookmark by title: ${title} (id: ${bm.id})`);
                id = bm.id;
            } else if (!id && url && bm.url && bm.url == url) {
                console.debug(`Found bookmark by url: ${url} (id: ${bm.id})`);
                id = bm.id;
            }

            if (!id && bm.children) {
                recursiveSearch(bm.children, title, url);
            }
        });
    }

    return id.toString();
}

async function createBookmarkFolder(parentId, title) {
    // If folder doesn't exist yet, create it and store the node id
    let newFolder = await createBookmark(
        { 'parentId': parentId, 'title': title });
    console.debug(`Created folder ${title} (${newFolder.id})`);
    return newFolder.id.toString();
}

async function getSavedGroupsBookmarkId() {
    let bm = await chrome.bookmarks.getTree();
    return searchBookmarks(bm, SAVED_GROUPS_FOLDER_NAME);
}

async function getBookmarksBarId() {
    let bm = await chrome.bookmarks.getTree();
    return searchBookmarks(bm, BOOKMARKS_BAR_NAME);
}

async function createSavedGroupsFolder() {
    let bookmarksBarId = await getBookmarksBarId();
    if (bookmarksBarId == '0') {
        // Is it possible that there is no Bookmarks bar?
        console.error(`No ${BOOKMARKS_BAR_NAME}!!`);
    }

    return createBookmarkFolder(bookmarksBarId, SAVED_GROUPS_FOLDER_NAME);
}

async function createOrGetSavedGroupsFolder() {
    let savedGroupsFolderId = await getSavedGroupsBookmarkId();

    // If we have an id, it means the group bookmarks folder exists
    if (savedGroupsFolderId != '0') {
        console.debug(`Found bookmark ${SAVED_GROUPS_FOLDER_NAME} (${savedGroupsFolderId})`);
        return savedGroupsFolderId;
    }

    savedGroupsFolderId = await createSavedGroupsFolder();
    console.debug(`Created bookmark folder ${SAVED_GROUPS_FOLDER_NAME} (${savedGroupsFolderId})`);
    return savedGroupsFolderId;
}

async function createOrGetbookmarkFolder(savedGroupsFolderId, title) {
    let bm = await chrome.bookmarks.getSubTree(savedGroupsFolderId);
    let folderId = searchBookmarks(bm, title);

    // If we have an id, it means the group bookmarks folder exists
    if (folderId != '0') {
        console.debug(`Found bookmark ${title} (${folderId})`);
        return folderId;
    }

    folderId = await createBookmarkFolder(savedGroupsFolderId, title);
    console.debug(`Created bookmark folder ${title} (${folderId})`);
    return folderId;
}

function formatTabGroupName(tabGroup) {
    // To support identical group names, we need to add an ID to the bookmark.
    // As for Aug 21, Chrome are adding the option to open a bokkmark folder as a group,
    // so it seems nicer to have the folder name without an id even though it prevents 
    // bookmarking identical group names
    // return tabGroup.title + ' (id: ' + tabGroup.id + ')';
    return tabGroup.title;
}

// Don't use the tab passes in the listener cb, the groupid is -1 for tabs with pdf
async function onClickSave(info, _tab) {
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Return if not part of group
    if (tab.groupId < 0) {
        return;
    }

    // Get the group id the current tab is in
    let tabGroup = await chrome.tabGroups.get(tab.groupId);

    // Make sure the Saved Groups folder exists
    let savedGroupsFolderId = await createOrGetSavedGroupsFolder();

    let groupBookmarkFolderName = formatTabGroupName(tabGroup);
    console.debug(`Saving tab group ${groupBookmarkFolderName} (${tab.groupId})`);

    // Create a folder
    let groupBookmarkId = await createOrGetbookmarkFolder(savedGroupsFolderId, groupBookmarkFolderName)

    // And and all tabs within the group
    await saveGroupTabs(tab.groupId, groupBookmarkId);

    updateFullCtxMenu();
}

async function onClickOpen(info, _tab) {
    let groupId = 0;
    let id = info.menuItemId.split(BMG_MENU_OPEN_ID)[1]; // TODO: check there is [1]
    let bmTreeNodes = await chrome.bookmarks.getChildren(id);

    for (var idx = 0; idx < bmTreeNodes.length; idx++) {
        if (!idx) {
            let tab = await chrome.tabs.create({
                url: bmTreeNodes[idx].url
            });
            groupId = await chrome.tabs.group({ 'tabIds': tab.id });
            let bmTreeNode = await chrome.bookmarks.get(id);
            chrome.tabGroups.update(groupId, { 'title': bmTreeNode[0].title })
        } else {
            chrome.tabs.create({
                url: bmTreeNodes[idx].url
            }, (tab) => {
                chrome.tabs.group({ 'tabIds': tab.id, 'groupId': groupId })
            });
        }
    }
}

async function onClickCopy(info, _tab) {
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let id = info.menuItemId.split(BMG_MENU_COPY_ID)[1]; // TODO: check there is [1]
    let bmTreeNodes = await chrome.bookmarks.getChildren(id);
    var text = "";
    bmTreeNodes.forEach(function (bm) {
        text += bm.title + " @ " + bm.url + '\n';
    });

    chrome.scripting.executeScript({
        target: { tabId: tab.id },
        args: [text],
        func: injectedFunction
    }, () => {
        // This is probably a chrome:// type tab
        // TODO: avoid adding the context menu to such tabs
        let e = chrome.runtime.lastError;
        if (e) {
            console.debug(e.message);
        }
    });

    function injectedFunction(text) {
        let input = document.createElement('textarea');
        document.body.appendChild(input);
        input.value = text;
        input.focus();
        input.select();
        document.execCommand("copy");
        input.remove();
    }
}

async function updateSaveCtxMenu() {
    // Get the active tab and update the context menue
    let tabs = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tabs.length || tabs[0] == undefined || tabs[0].groupId < 0) {
        chrome.contextMenus.update(BMG_MENU_SAVE_ID, {
            'enabled': false,
            'title': 'The tab isn\'t part of a group',
        }, () => {
            let e = chrome.runtime.lastError;
            if (e) {
                console.debug(e.message);
            }
        });
        return;
    }

    // Get the group id the current tab is in
    let tabGroup = await chrome.tabGroups.get(tabs[0].groupId);

    chrome.contextMenus.update(BMG_MENU_SAVE_ID, {
        'title': 'Save \'' + (tabGroup.title ? tabGroup.title : 'no name') + '\'',
        "contexts": ["all"],
        'enabled': true
    }, () => {
        let e = chrome.runtime.lastError;
        if (e) {
            console.debug(e.message);
        }
    });
}

// on click id's
var BMG_MENU_PARENT_ID = "SaveTabsGroup";
var BMG_MENU_SAVE_ID = BMG_MENU_PARENT_ID + "Save"
var BMG_MENU_SEP1_ID = BMG_MENU_PARENT_ID + "Separator1"
var BMG_MENU_OPEN_ID = BMG_MENU_PARENT_ID + "Open"
var BMG_MENU_COPY_ID = BMG_MENU_PARENT_ID + "Copy"

async function updateFullCtxMenu() {
    //Remove old bookmarks from ctx menu and add the current ones
    chrome.contextMenus.removeAll(() => {

        console.debug(`Removed all ctx menues`);
        let e = chrome.runtime.lastError; // it's possible the menu doesn't exist
        if (e) {
            console.debug(e.message);
        }

        createCtxMenu();
    });

    async function createCtxMenu() {
        await chrome.contextMenus.create({
            "title": 'Group',
            "contexts": ["all"],
            "id": BMG_MENU_PARENT_ID,
        });

        await chrome.contextMenus.create({
            "title": 'Save',
            "contexts": ["all"],
            "id": BMG_MENU_SAVE_ID,
            "parentId": BMG_MENU_PARENT_ID,
        });

        updateSaveCtxMenu();

        let savedGroupsFolderId = await getSavedGroupsBookmarkId();
        // No save folder, nothing to do
        if (savedGroupsFolderId == '0') {
            return;
        }

        let bms = await chrome.bookmarks.getChildren(savedGroupsFolderId);
        // No bookmarks
        if (!bms.length) {
            return;
        }

        // Create separator
        chrome.contextMenus.create({
            "contexts": ["all"],
            "type": "separator",
            "id": BMG_MENU_SEP1_ID,
            "parentId": BMG_MENU_PARENT_ID,
        }, () => {
            let e = chrome.runtime.lastError;
            if (e) {
                console.debug(e.message);
            }
        });

        createMenu('Open', BMG_MENU_OPEN_ID);
        createMenu('Copy', BMG_MENU_COPY_ID);

        function createMenu(operation_title, id) {
            chrome.contextMenus.create({
                "title": operation_title,
                "contexts": ["all"],
                "id": id,
                "parentId": BMG_MENU_PARENT_ID,
            }, () => {
                bms.forEach(function (bm) {
                    // Add  only folders (have children) to menue
                    chrome.bookmarks.getChildren(bm.id, (children) => {
                        if (!children.length) {
                            return;
                        }
                        bm_title = bm.title ? bm.title : "no name";
                        console.debug(`Adding folder: ${bm_title} (${bm.id}) to ${operation_title} menu`);

                        chrome.contextMenus.create({
                            "title": bm_title,
                            "contexts": ["all"],
                            "id": id + bm.id,
                            "parentId": id,
                        });

                    });
                });
            });
        }
    }
}

// Listeners
chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId == BMG_MENU_SAVE_ID) {
        onClickSave(info, tab);
    } else if (info.menuItemId.startsWith(BMG_MENU_OPEN_ID)) {
        onClickOpen(info, tab)
    } else if (info.menuItemId.startsWith(BMG_MENU_COPY_ID)) {
        onClickCopy(info, tab);
    }
});

// Update context menu to group name
chrome.tabs.onActivated.addListener((tabGroup) => {
    updateSaveCtxMenu();
});

chrome.tabGroups.onCreated.addListener((tabGroup) => {
    updateSaveCtxMenu();
});

chrome.tabGroups.onMoved.addListener((tabGroup) => {
    updateSaveCtxMenu();
});

chrome.tabGroups.onRemoved.addListener((tabGroup) => {
    updateSaveCtxMenu();
});

chrome.tabGroups.onUpdated.addListener((tabGroup) => {
    updateSaveCtxMenu();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    updateSaveCtxMenu();
});

function bookmarkListener(tag) {
    console.debug(`${tag}: createRef: ${createRef}`);
    if (createRef) {
        createRef--;
        return;
    }
    updateFullCtxMenu();
}

chrome.bookmarks.onChanged.addListener((id, changeInfo) => {
    bookmarkListener(`onChanged: ${id}, ${changeInfo.title}`);
});

chrome.bookmarks.onCreated.addListener((id, bm) => {

    bookmarkListener(`onCreated: ${id}, ${bm.title}`);
});

chrome.bookmarks.onMoved.addListener((id, moveInfo) => {
    bookmarkListener(`onMoved: ${id}`);
});

chrome.bookmarks.onRemoved.addListener((id, removeInfo) => {
    bookmarkListener(`onRemoved: ${id}`);
});

// Install
chrome.runtime.onInstalled.addListener(() => {
    updateFullCtxMenu();
});

//TODO:
// Error handling...
// Save group color in the storage, and restore it from there