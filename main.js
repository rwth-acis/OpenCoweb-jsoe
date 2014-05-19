require([ "dojo"
				, "coweb/jsoe/OTEngine"
				, "dojo/dom"
				] , function(dojo , OTEngine, dom) {

	var FETCH_INTERVAL = 500;
	var SYNC_INTERVAL = 10000;
	var PURGE_INTERVAL = 10000;
	var ote = null;

	var iwcClient;

	var context;
	var members = [];
	var membersNumber = 0;
	var user;

	var connection = null;
	var collaborators;
	collaborators = [];

	var state = [];

	this.jid_map = {};

	//variable used for referencing the openApp space
	var space;

	//variables used for storing the text file
	var master = false;
	var textURI = "";

	// use a buffer for storing the key pressed, for the case when many intents should be sent
	// in a very short time period (see Dominik Renzels IWC Paint Widget)
	var actionbuffer = [];
	var actionbuffermaxlength = 50;
	var actionbufferflushdelay = 1050;

	saveTextDelay = 10000;

	var t = 0;
	var saveTime = 0;

	var xmppClient;

	var shouldPurge = false;
	var shouldSync = false;
	// Timers for syncing and purging.
	var syncTimer = setInterval(
			function() {
				engineSyncOutbound();
			}
			, SYNC_INTERVAL );
	var purgeTimer = setInterval(
			function() {
				onPurgeEngine();
			}
			, PURGE_INTERVAL);

	/**
    Initialize:
      *the current user, 
      *the vector of users which are members in the same space
      *the previously saved text (using openApp)
  */
	openapp.resource.get(openapp.param.space(), function(s) {
		context = s;
		openapp.resource.get(openapp.param.user(), function(u) {
			user = u;
			newGetUsers();
		});

	});

	/**
  * Function meant for retrieving the unique identifiers of users,
  * available in the information section, under "http://www.w3.org/2002/07/owl#sameAs"
  */
	newGetUsers = function() {

		var spaceURI = openapp.param.space();
		space = new openapp.oo.Resource(spaceURI);

		space.getSubResources({
			relation: openapp.ns.foaf + "member",
			onEach: renderEntry
		});

	};

	/**
  * Function to be called for each discovered member of the space
  */
	renderEntry = function(entryResource) {

		var entry = new openapp.oo.Resource(entryResource.getURI());

		var mlist = openapp.resource.context(context).sub(openapp.ns.foaf + "member").list();
		membersNumber = mlist.length;

		entry.getInfo(function(metadata1) {

			members.push(metadata1["http://www.w3.org/2002/07/owl#sameAs"]);
			console.log("In the renderEntry call, the members vector is:");
			console.log(members);

			if (metadata1["http://www.w3.org/2002/07/owl#sameAs"] !== user.uri) {
				collaborators.push(metadata1["http://www.w3.org/2002/07/owl#sameAs"]);
			}

			if (members.length === membersNumber) {
				start_collaboration();
			}
		});
	};

	/**
  * Initialize the OT
  */
	start_collaboration = function() {

		//var buffer = $('#editArea').val();
		members.sort();
		for (k = 0; k < members.length; k++) {
			jid_map[members[k]] = k;
			state.push(0);
		}

		init();
	};

	/**
    * Initializations and behavior specification for IWC Client, events, handlers, etc. 
    */
	init = function() {
		console.log("jid_map");
		console.log(jid_map);
		console.log(members);

		ote = new OTEngine(jid_map[user.uri]);

		iwcClient = new iwc.Client();

		var iwcCallback = function(intent) {
			console.log("******** IWC WRITE *************************");
			console.log(intent);
			console.log("********************************************");

			if (intent.action === "ACTION_WRITE") {
				if (intent.sender.indexOf("@") > - 1) {
					var len = intent.extras.names.length;
					var i;
					for(i=0; i<len; i++){
						var toApply = ote.remoteEvent( 
										parseInt(new Date().getTime(),10)	// order 
									, intent.extras.names[i]						// data  
									);
						if(toApply){
							update_pad(toApply);
						} else {
							console.error("Couldn't apply remote Event!!!!");
						}
					}
				}
			}

			if (intent.action === "ACTION_SYNC") {
				if (intent.sender.indexOf("@") > - 1) {
					ote.syncInbound(intent.extras.site, intent.extras.sites);
				}
			}

			if (intent.action === "ACTION_LOAD_TEXT") {
				if (user.uri === intent.extras.expeditor) {
					master = true;
				}
				dom.byId("editArea").disabled = false;
				dom.byId('documentTitle').innerHTML = intent.extras.title;
				dom.byId('editArea').value = intent.extras.text;
				textURI = intent.extras.textUri;
				ote.purge();
			}

			if (intent.action === "EDIT_NEW_TEXT") {
				if (user.uri === intent.extras.expeditor) {
					master = true;
				}
				textURI = intent.extras.textURI;
				dom.byId('documentTitle').innerHTML = intent.extras.textTitle;
				dom.byId("editArea").disabled = false;
			}
		};

		iwcClient.connect(iwcCallback);

		dojo.connect(dom.byId("editArea"), "keypress", function(ev) {

			ev.preventDefault();
			ev.stopPropagation();
			var idx = this.selectionStart;
			var handled = true;
			var op;
			if (ev.which === 8) {									// backwards delete 
				op = ote.createOp("change", String.fromCharCode(ev.which), "delete", idx - 1);
			} else if (ev.which === 46) {					// forwards delete 
				op = ote.createOp("change", String.fromCharCode(ev.which), "delete", idx);
			} else if (		(	 ev.which >= 32
									  && ev.which <= 127 
										&& ev.which !== 37 
										&& ev.which !== 38 
										&& ev.which !== 39 
										&& ev.which !== 40 ) 
								 || ev.which >= 256) {			// ascii char or number
				op = ote.createOp("change", String.fromCharCode(ev.which), "insert", idx);
			} else {
				return;
			}
			update_pad(op);
			comm.sendOp(jid_map[user.uri], ote.localEvent(op));
			shouldSync = true;

			//if no delay timer has been set or the delay timer has been reset, set new delay timer.
			if (t === 0) {
				t = setTimeout(flush_actions, actionbufferflushdelay);
			}

			// if buffer length exceeds maximum, flush buffer.
			if (actionbuffer.length >= actionbuffermaxlength) {
				flush_actions();
			}

		});
	};

	/**
    * Update the value of textarea with the characters which were already synchronized
    */
	update_pad = function(op) {
		// update cursur
		var text = dom.byId("editArea");
		var old_pos_start = text.selectionStart;
		var old_pos_end = text.selectionEnd;

		if(op.type === "insert"){
			if (op.position <= old_pos_start ) {
					old_pos_start += 1;
			}
			if (op.position <= old_pos_end ) {
					old_pos_end += 1;
			}
		} else if(op.type === "delete"){
			if (op.position < old_pos_start ) {
				old_pos_start -= 1;
			}
			if (op.position < old_pos_end ) {
				old_pos_end -= 1;
			}
		}
									 
		// update TextBox
		if (master) {
			if (saveTime === 0) {
				saveTime = setTimeout(saveExistingText, saveTextDelay);
			}
		}

		console.log("Local operation is : " + op);
		text.value = exec_ops(text.value, op);
		
		// set the updated cursur 
		text.selectionStart = old_pos_start;
		text.selectionEnd = old_pos_end;
	};

	exec_ops = function(txt, ops) {
		var textAreaArray = dom.byId("editArea").value.split();

		if (textAreaArray.length > 0) {
			textAreaArray = textAreaArray.splice(ops.position, 0, ops.value);
			console.log("Current textAreaArray:");
			console.log(textAreaArray);
		} else {
			textAreaArray = [ops.value];
		}
		switch (ops.type) {
			case 'insert':
				txt = txt.replace(
					new RegExp( ['([\\s\\S]{' , ops.position, '})'].join(''))
										, '$1' + ops.value);
				break;
			case 'delete':
				txt = txt.replace(
						new RegExp( ['([\\s\\S]{'
												, ops.position
												, '})[\\s\\S]{0,'
											  , ops.value.length
												, '}'
												].join('')), '$1');
				break;
			default:
				break;
		}
		return txt;
	};

	flush_actions = function() {

		// when we flush, we first clear the delay timer, if running.
		clearTimeout(t);
		t = 0;

		// then, we pack all buffered actions into one intent.
		if (actionbuffer.length > 0) {

			var expeditor = [];
			var oper = [];

			var i;
			for (i = 0; i < actionbuffer.length; i++) {
				var a = actionbuffer[i];
				expeditor.push(a.expeditor);
				oper.push(a.operation);
			}
			actionbuffer = [];

			var intents = {
				"component": "",
				"action": "ACTION_WRITE",
				"data": "",
				"dataType": "text/plain",
				"flags": ["PUBLISH_GLOBAL"],
				"extras": {
					"expeditors": expeditor,
					"names": oper
				}
			};

			sendIntent(intents);
		}
	};

	/**
    * Function used for sending an intent via the iwc client
    */
	sendIntent = function(intent) {
		if (iwc.util.validateIntent(intent)) {
			iwcClient.publish(intent);
		} else {
			alert("Intent not valid!");
		}
	};

	/** 
	 * TODO
   */
	engineSyncOutbound = function() {
		if (shouldSync) {
			var toSend = ote.syncOutbound();
			try {
				comm.engineSync(jid_map[user.uri], toSend);
			} catch(e) {
				console.warn("Failed to send engine syncs to server ", e);
				return;
			}
			shouldSync = false;
		}
	};

	/** TODO
    */
	onPurgeEngine = function() {
		if (shouldPurge) {
			alert("Operation Transformator Engine is stable:" + ote.isStable());
		}
		ote.purge();
		shouldPurge = false;
	};

	saveExistingText = function() {
		clearTimeout(saveTime);
		saveTime = 0;
		if (master) {
			if (textURI !== "") {

				updateLiteral(textURI);
				var intent = {
					"component": "",
					"sender": user.uri,
					"data": "http://example.org/some/data",
					"dataType": "text/json",
					"action": "ACTION_DATA_SAVED",
					"flags": ["PUBLISH_GLOBAL"],
					"extras": {
						"expeditor": user.uri,
					}
				};
				sendIntent(intent);
			}
		}
	};

	updateLiteral = function(textUri) {
		var doc = dom.byId("editArea").value;
		var currentTime = new Date();
		var title = dom.byId("documentTitle").innerHTML;

		console.log("..deleting" + textUri);
		openapp.resource.del(textUri);

		var documentText = {
			"title": title,
			"text": doc,
			"date": currentTime.toGMTString()
		};
		space.create({
			relation: openapp.ns.role + "data",
			type: "my:ns:documentText",
			representation: documentText,
			callback: function(sub) {
				console.log("MAKING NEW RESOURCE..");
				console.log(sub);
				textURI = sub.uri;
				console.log(sub.uri);
				console.log(textURI);
			}
		});
	};

	/**
    * This is our how we communicate with the server. We send an XHR
    * request every FETCH_INTERVAL milliseconds to fetch remote operations.
    *
    * See client.js (the server implementation) for more on the details
    * of connecting, fetching, etc.
    */
	var Comm = function() { };

	var proto = Comm.prototype;
	proto.engineSync = function(site, cv) {
		var obj = {
			site: site,
			sites: cv
		};
		var intent = {
			"component": "",
			"action": "ACTION_SYNC",
			"data": "",
			"dataType": "text/plain",
			"flags": ["PUBLISH_GLOBAL"],
			"extras": {
				"site": site,
				"sites": cv
			}
		};
		console.log(intent);
		sendIntent(intent);
	};

	proto.sendOp = function(user, op) {
		var a = {
			"expeditor": user,
			"operation": op
		};

		actionbuffer.push(a);
	};

	var comm = new Comm();
});

