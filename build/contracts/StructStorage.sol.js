var Web3 = require("web3");
var SolidityEvent = require("web3/lib/web3/event.js");

(function() {
  // Planned for future features, logging, etc.
  function Provider(provider) {
    this.provider = provider;
  }

  Provider.prototype.send = function() {
    this.provider.send.apply(this.provider, arguments);
  };

  Provider.prototype.sendAsync = function() {
    this.provider.sendAsync.apply(this.provider, arguments);
  };

  var BigNumber = (new Web3()).toBigNumber(0).constructor;

  var Utils = {
    is_object: function(val) {
      return typeof val == "object" && !Array.isArray(val);
    },
    is_big_number: function(val) {
      if (typeof val != "object") return false;

      // Instanceof won't work because we have multiple versions of Web3.
      try {
        new BigNumber(val);
        return true;
      } catch (e) {
        return false;
      }
    },
    merge: function() {
      var merged = {};
      var args = Array.prototype.slice.call(arguments);

      for (var i = 0; i < args.length; i++) {
        var object = args[i];
        var keys = Object.keys(object);
        for (var j = 0; j < keys.length; j++) {
          var key = keys[j];
          var value = object[key];
          merged[key] = value;
        }
      }

      return merged;
    },
    promisifyFunction: function(fn, C) {
      var self = this;
      return function() {
        var instance = this;

        var args = Array.prototype.slice.call(arguments);
        var tx_params = {};
        var last_arg = args[args.length - 1];

        // It's only tx_params if it's an object and not a BigNumber.
        if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
          tx_params = args.pop();
        }

        tx_params = Utils.merge(C.class_defaults, tx_params);

        return new Promise(function(accept, reject) {
          var callback = function(error, result) {
            if (error != null) {
              reject(error);
            } else {
              accept(result);
            }
          };
          args.push(tx_params, callback);
          fn.apply(instance.contract, args);
        });
      };
    },
    synchronizeFunction: function(fn, instance, C) {
      var self = this;
      return function() {
        var args = Array.prototype.slice.call(arguments);
        var tx_params = {};
        var last_arg = args[args.length - 1];

        // It's only tx_params if it's an object and not a BigNumber.
        if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
          tx_params = args.pop();
        }

        tx_params = Utils.merge(C.class_defaults, tx_params);

        return new Promise(function(accept, reject) {

          var decodeLogs = function(logs) {
            return logs.map(function(log) {
              var logABI = C.events[log.topics[0]];

              if (logABI == null) {
                return null;
              }

              var decoder = new SolidityEvent(null, logABI, instance.address);
              return decoder.decode(log);
            }).filter(function(log) {
              return log != null;
            });
          };

          var callback = function(error, tx) {
            if (error != null) {
              reject(error);
              return;
            }

            var timeout = C.synchronization_timeout || 240000;
            var start = new Date().getTime();

            var make_attempt = function() {
              C.web3.eth.getTransactionReceipt(tx, function(err, receipt) {
                if (err) return reject(err);

                if (receipt != null) {
                  // If they've opted into next gen, return more information.
                  if (C.next_gen == true) {
                    return accept({
                      tx: tx,
                      receipt: receipt,
                      logs: decodeLogs(receipt.logs)
                    });
                  } else {
                    return accept(tx);
                  }
                }

                if (timeout > 0 && new Date().getTime() - start > timeout) {
                  return reject(new Error("Transaction " + tx + " wasn't processed in " + (timeout / 1000) + " seconds!"));
                }

                setTimeout(make_attempt, 1000);
              });
            };

            make_attempt();
          };

          args.push(tx_params, callback);
          fn.apply(self, args);
        });
      };
    }
  };

  function instantiate(instance, contract) {
    instance.contract = contract;
    var constructor = instance.constructor;

    // Provision our functions.
    for (var i = 0; i < instance.abi.length; i++) {
      var item = instance.abi[i];
      if (item.type == "function") {
        if (item.constant == true) {
          instance[item.name] = Utils.promisifyFunction(contract[item.name], constructor);
        } else {
          instance[item.name] = Utils.synchronizeFunction(contract[item.name], instance, constructor);
        }

        instance[item.name].call = Utils.promisifyFunction(contract[item.name].call, constructor);
        instance[item.name].sendTransaction = Utils.promisifyFunction(contract[item.name].sendTransaction, constructor);
        instance[item.name].request = contract[item.name].request;
        instance[item.name].estimateGas = Utils.promisifyFunction(contract[item.name].estimateGas, constructor);
      }

      if (item.type == "event") {
        instance[item.name] = contract[item.name];
      }
    }

    instance.allEvents = contract.allEvents;
    instance.address = contract.address;
    instance.transactionHash = contract.transactionHash;
  };

  // Use inheritance to create a clone of this contract,
  // and copy over contract's static functions.
  function mutate(fn) {
    var temp = function Clone() { return fn.apply(this, arguments); };

    Object.keys(fn).forEach(function(key) {
      temp[key] = fn[key];
    });

    temp.prototype = Object.create(fn.prototype);
    bootstrap(temp);
    return temp;
  };

  function bootstrap(fn) {
    fn.web3 = new Web3();
    fn.class_defaults  = fn.prototype.defaults || {};

    // Set the network iniitally to make default data available and re-use code.
    // Then remove the saved network id so the network will be auto-detected on first use.
    fn.setNetwork("default");
    fn.network_id = null;
    return fn;
  };

  // Accepts a contract object created with web3.eth.contract.
  // Optionally, if called without `new`, accepts a network_id and will
  // create a new version of the contract abstraction with that network_id set.
  function Contract() {
    if (this instanceof Contract) {
      instantiate(this, arguments[0]);
    } else {
      var C = mutate(Contract);
      var network_id = arguments.length > 0 ? arguments[0] : "default";
      C.setNetwork(network_id);
      return C;
    }
  };

  Contract.currentProvider = null;

  Contract.setProvider = function(provider) {
    var wrapped = new Provider(provider);
    this.web3.setProvider(wrapped);
    this.currentProvider = provider;
  };

  Contract.new = function() {
    if (this.currentProvider == null) {
      throw new Error("StructStorage error: Please call setProvider() first before calling new().");
    }

    var args = Array.prototype.slice.call(arguments);

    if (!this.unlinked_binary) {
      throw new Error("StructStorage error: contract binary not set. Can't deploy new instance.");
    }

    var regex = /__[^_]+_+/g;
    var unlinked_libraries = this.binary.match(regex);

    if (unlinked_libraries != null) {
      unlinked_libraries = unlinked_libraries.map(function(name) {
        // Remove underscores
        return name.replace(/_/g, "");
      }).sort().filter(function(name, index, arr) {
        // Remove duplicates
        if (index + 1 >= arr.length) {
          return true;
        }

        return name != arr[index + 1];
      }).join(", ");

      throw new Error("StructStorage contains unresolved libraries. You must deploy and link the following libraries before you can deploy a new version of StructStorage: " + unlinked_libraries);
    }

    var self = this;

    return new Promise(function(accept, reject) {
      var contract_class = self.web3.eth.contract(self.abi);
      var tx_params = {};
      var last_arg = args[args.length - 1];

      // It's only tx_params if it's an object and not a BigNumber.
      if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
        tx_params = args.pop();
      }

      tx_params = Utils.merge(self.class_defaults, tx_params);

      if (tx_params.data == null) {
        tx_params.data = self.binary;
      }

      // web3 0.9.0 and above calls new twice this callback twice.
      // Why, I have no idea...
      var intermediary = function(err, web3_instance) {
        if (err != null) {
          reject(err);
          return;
        }

        if (err == null && web3_instance != null && web3_instance.address != null) {
          accept(new self(web3_instance));
        }
      };

      args.push(tx_params, intermediary);
      contract_class.new.apply(contract_class, args);
    });
  };

  Contract.at = function(address) {
    if (address == null || typeof address != "string" || address.length != 42) {
      throw new Error("Invalid address passed to StructStorage.at(): " + address);
    }

    var contract_class = this.web3.eth.contract(this.abi);
    var contract = contract_class.at(address);

    return new this(contract);
  };

  Contract.deployed = function() {
    if (!this.address) {
      throw new Error("Cannot find deployed address: StructStorage not deployed or address not set.");
    }

    return this.at(this.address);
  };

  Contract.defaults = function(class_defaults) {
    if (this.class_defaults == null) {
      this.class_defaults = {};
    }

    if (class_defaults == null) {
      class_defaults = {};
    }

    var self = this;
    Object.keys(class_defaults).forEach(function(key) {
      var value = class_defaults[key];
      self.class_defaults[key] = value;
    });

    return this.class_defaults;
  };

  Contract.extend = function() {
    var args = Array.prototype.slice.call(arguments);

    for (var i = 0; i < arguments.length; i++) {
      var object = arguments[i];
      var keys = Object.keys(object);
      for (var j = 0; j < keys.length; j++) {
        var key = keys[j];
        var value = object[key];
        this.prototype[key] = value;
      }
    }
  };

  Contract.all_networks = {
  "default": {
    "abi": [
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "name": "fm",
        "outputs": [
          {
            "name": "pid",
            "type": "bytes"
          },
          {
            "name": "pname",
            "type": "bytes32"
          },
          {
            "name": "loc",
            "type": "bytes32"
          },
          {
            "name": "disease",
            "type": "bytes32"
          },
          {
            "name": "contact",
            "type": "uint256"
          },
          {
            "name": "doctor",
            "type": "bytes32"
          },
          {
            "name": "rgprice",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "j",
            "type": "bytes"
          }
        ],
        "name": "getproduce",
        "outputs": [
          {
            "name": "",
            "type": "bytes"
          },
          {
            "name": "",
            "type": "bytes32"
          },
          {
            "name": "",
            "type": "bytes32"
          },
          {
            "name": "",
            "type": "bytes32"
          },
          {
            "name": "",
            "type": "uint256"
          },
          {
            "name": "",
            "type": "bytes32"
          },
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "k",
            "type": "bytes"
          }
        ],
        "name": "gettest",
        "outputs": [
          {
            "name": "",
            "type": "bytes"
          },
          {
            "name": "",
            "type": "bytes"
          },
          {
            "name": "",
            "type": "uint256"
          },
          {
            "name": "",
            "type": "bytes32"
          },
          {
            "name": "",
            "type": "bytes32"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "name": "l",
        "outputs": [
          {
            "name": "testno",
            "type": "bytes"
          },
          {
            "name": "group",
            "type": "bytes"
          },
          {
            "name": "charge",
            "type": "uint256"
          },
          {
            "name": "testdate",
            "type": "bytes32"
          },
          {
            "name": "result",
            "type": "bytes32"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "id",
            "type": "bytes"
          },
          {
            "name": "name",
            "type": "bytes32"
          },
          {
            "name": "loc",
            "type": "bytes32"
          },
          {
            "name": "cr",
            "type": "bytes32"
          },
          {
            "name": "con",
            "type": "uint256"
          },
          {
            "name": "q",
            "type": "bytes32"
          },
          {
            "name": "pr",
            "type": "uint256"
          }
        ],
        "name": "produce",
        "outputs": [],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "tester",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "s",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "t",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "ll",
            "type": "bytes"
          },
          {
            "name": "g",
            "type": "bytes"
          },
          {
            "name": "p",
            "type": "uint256"
          },
          {
            "name": "tt",
            "type": "bytes32"
          },
          {
            "name": "e",
            "type": "bytes32"
          }
        ],
        "name": "test1",
        "outputs": [],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "receiver",
            "type": "address"
          },
          {
            "name": "amount",
            "type": "uint256"
          },
          {
            "name": "sender",
            "type": "address"
          }
        ],
        "name": "sendCoin",
        "outputs": [
          {
            "name": "sufficient",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "c",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "addr",
            "type": "address"
          }
        ],
        "name": "getBalance",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "addr",
            "type": "address"
          }
        ],
        "name": "fundaddr",
        "outputs": [],
        "type": "function"
      }
    ],
    "unlinked_binary": "0x6060604052600160006000505560016002600050556114f8806100226000396000f3606060405236156100a35760e060020a600035046307467a0281146100a55780632c6d8fa7146100ef57806342d466c1146103b557806354bb1361146105f85780637d02b89f146106ca5780638308abd41461085957806386b714e21461086b57806392d0d153146108745780639621cb3d1461087d578063b81e3a5014610a0b578063c3da42b814610a40578063f8b2cb4f14610a49578063fb5ade3114610a77575b005b610a9b600435600780548290811015610002579060005260206000209060070201600050600281015460038201546004830154600184015460058501546006860154959650909487565b6040805160206004803580820135601f8101849004840285018401909552848452610b549491936024939092918401919081908401838280828437509496505050505050506020604051908101604052806000815260200150600060006000600060006000600660005088604051808280519060200190808383829060006004602084601f0104600302600f01f1509050019150509081526020016040518091039020600050600001600050600660005089604051808280519060200190808383829060006004602084601f0104600302600f01f15090500191505090815260200160405180910390206000506001016000505460066000508a604051808280519060200190808383829060006004602084601f0104600302600f01f15090500191505090815260200160405180910390206000506002016000505460066000508b604051808280519060200190808383829060006004602084601f0104600302600f01f15090500191505090815260200160405180910390206000506003016000505460066000508c604051808280519060200190808383829060006004602084601f0104600302600f01f15090500191505090815260200160405180910390206000506004016000505460066000508d604051808280519060200190808383829060006004602084601f0104600302600f01f15090500191505090815260200160405180910390206000506005016000505460066000508e604051808280519060200190808383829060006004602084601f0104600302600f01f150905001915050908152602001604051809103902060005060060160005054868054600181600116156101000203166002900480601f016020809104026020016040519081016040528092919081815260200182805460018160011615610100020316600290048015610e5e5780601f10610e3357610100808354040283529160200191610e5e565b6040805160206004803580820135601f8101849004840285018401909552848452610bfc94919360249390929184019190819084018382808284375094965050505050505060206040519081016040528060008152602001506020604051908101604052806000815260200150600060006000600860005086604051808280519060200190808383829060006004602084601f0104600302600f01f1509050019150509081526020016040518091039020600050600001600050600860005087604051808280519060200190808383829060006004602084601f0104600302600f01f1509050019150509081526020016040518091039020600050600101600050600860005088604051808280519060200190808383829060006004602084601f0104600302600f01f150905001915050908152602001604051809103902060005060020160005054600860005089604051808280519060200190808383829060006004602084601f0104600302600f01f15090500191505090815260200160405180910390206000506003016000505460086000508a604051808280519060200190808383829060006004602084601f0104600302600f01f150905001915050908152602001604051809103902060005060040160005054848054600181600116156101000203166002900480601f016020809104026020016040519081016040528092919081815260200182805460018160011615610100020316600290048015610ea95780601f10610e7e57610100808354040283529160200191610ea9565b610ce660043560098054829081101561000257506000526005027f6e1540171b6c0c960b71a7020d9f60077f6af931a8bbf590da0223dacf75c7b18101547f6e1540171b6c0c960b71a7020d9f60077f6af931a8bbf590da0223dacf75c7b28201547f6e1540171b6c0c960b71a7020d9f60077f6af931a8bbf590da0223dacf75c7b38301547f6e1540171b6c0c960b71a7020d9f60077f6af931a8bbf590da0223dacf75c7af8401937f6e1540171b6c0c960b71a7020d9f60077f6af931a8bbf590da0223dacf75c7b00192919085565b6040805160206004803580820135601f81018490048402850184019095528484526100a394919360249390929184019190819084018382808284375094965050933593505060443591505060643560843560a43560c43560e060405190810160405280602060405190810160405280600081526020015081526020016000815260200160008152602001600081526020016000815260200160008152602001600081526020015060e06040519081016040528089815260200188815260200187815260200186815260200185815260200184815260200183815260200150905080600660005089604051808280519060200190808383829060006004602084601f0104600302600f01f15090500191505090815260200160405180910390206000506000820151816000016000509080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f10610f5057805160ff19168380011785555b50610f809291505b80821115610ffc5760008155600101610845565b610e02600454600160a060020a031681565b610a6560005481565b610a6560025481565b6040805160206004803580820135601f81018490048402850184019095528484526100a3949193602493909291840191908190840183828082843750506040805160208835808b0135601f81018390048302840183019094528383529799986044989297509190910194509092508291508401838280828437509496505093359350506064359150506084356040805160c081018252600060a082810182815283528351602081810186528382528481019190915283850183905260608481018490526080948501849052855192830186528a83528282018a905282860189905282018790529281018590529251885184936008938b9392839285810192829185918391869190600490600f601f86019190910460030201f15090500191505090815260200160405180910390206000506000820151816000016000509080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f1061118457805160ff19168380011785555b506111b4929150610845565b610e1f600435602435604435600160a060020a038116600090815260036020526040812054839010156114c0575060006114f1565b610a6560015481565b600160a060020a03600435166000908152600360205260409020545b60408051918252519081900360200190f35b600160a060020a036004351660009081526003602052604090206107d090556100a3565b6040805160208101889052908101869052606081018590526080810184905260a0810183905260c0810182905260e080825288546002600182161561010090810260001901909216049183018290528291908201908a908015610b3f5780601f10610b1457610100808354040283529160200191610b3f565b820191906000526020600020905b815481529060010190602001808311610b2257829003601f168201915b50509850505050505050505060405180910390f35b6040518080602001886000191681526020018760001916815260200186600019168152602001858152602001846000191681526020018381526020018281038252898181518152602001915080519060200190808383829060006004602084601f0104600302600f01f150905090810190601f168015610be85780820380516001836020036101000a031916815260200191505b509850505050505050505060405180910390f35b60405180806020018060200186815260200185600019168152602001846000191681526020018381038352888181518152602001915080519060200190808383829060006004602084601f0104600302600f01f150905090810190601f168015610c7a5780820380516001836020036101000a031916815260200191505b508381038252878181518152602001915080519060200190808383829060006004602084601f0104600302600f01f150905090810190601f168015610cd35780820380516001836020036101000a031916815260200191505b5097505050505050505060405180910390f35b60408051908101849052606081018390526080810182905260a08082528654600260018216156101000260001901909116049082018190528190602082019060c083019089908015610d795780601f10610d4e57610100808354040283529160200191610d79565b820191906000526020600020905b815481529060010190602001808311610d5c57829003601f168201915b505083810382528754600260018216156101000260001901909116048082526020919091019088908015610dee5780601f10610dc357610100808354040283529160200191610dee565b820191906000526020600020905b815481529060010190602001808311610dd157829003601f168201915b505097505050505050505060405180910390f35b60408051600160a060020a03929092168252519081900360200190f35b604080519115158252519081900360200190f35b820191906000526020600020905b815481529060010190602001808311610e4157829003601f168201915b505050505096509650965096509650965096509650919395979092949650565b820191906000526020600020905b815481529060010190602001808311610e8c57829003601f168201915b5050875460408051602060026001851615610100026000190190941693909304601f8101849004840282018401909252818152959a5089945092508401905082828015610f375780601f10610f0c57610100808354040283529160200191610f37565b820191906000526020600020905b815481529060010190602001808311610f1a57829003601f168201915b50989f939e50959c50939a509198509650505050505050565b8280016001018555821561083d579182015b8281111561083d578251826000505591602001919060010190610f62565b5050602082015160018281019190915560408301516002830155606083015160038301556080830151600483015560a0830151600583015560c0909201516006909101556007805491820180825590919082818380158290116110005760070281600702836000526020600020918201910161100091906110a8565b5090565b5050509190906000526020600020906007020160008390919091506000820151816000016000509080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f106110fc57805160ff19168380011785555b5061112c929150610845565b50506000600182018190556002820181905560038201819055600482018190556005820181905560068201556007015b80821115610ffc57600060008201600050805460018160011615610100020316600290046000825580601f106110de5750611078565b601f0160209004906000526020600020908101906110789190610845565b8280016001018555821561106c579182015b8281111561106c57825182600050559160200191906001019061110e565b5050602082015160018281019190915560408301516002830155606083015160038301556080830151600483015560a0830151600583015560c090920151600690910155600080549091019055505050505050505050565b828001600101855582156109ff579182015b828111156109ff578251826000505591602001919060010190611196565b50506020820151816001016000509080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f1061121357805160ff19168380011785555b50611243929150610845565b82800160010185558215611207579182015b82811115611207578251826000505591602001919060010190611225565b50506040820151600282015560608201516003820155608090910151600491909101556009805460018101808355828183801582901161129c5760050281600502836000526020600020918201910161129c919061132f565b5050509190906000526020600020906005020160008390919091506000820151816000016000509080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f106113ca57805160ff19168380011785555b506113fa929150610845565b50506000600282018190556003820181905560048201556005015b80821115610ffc57600060008201600050805460018160011615610100020316600290046000825580601f1061138e57505b5060018201600050805460018160011615610100020316600290046000825580601f106113ac5750611314565b601f0160209004906000526020600020908101906113619190610845565b601f0160209004906000526020600020908101906113149190610845565b82800160010185558215611308579182015b828111156113085782518260005055916020019190600101906113dc565b50506020820151816001016000509080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f1061145957805160ff19168380011785555b50611489929150610845565b8280016001018555821561144d579182015b8281111561144d57825182600050559160200191906001019061146b565b5050604082015160028083019190915560608301516003830155608090920151600491909101558054600101905550505050505050565b50600160a060020a038181166000908152600360205260408082208054869003905591851681522080548301905560015b939250505056",
    "events": {},
    "updated_at": 1513247956595,
    "links": {},
    "address": "0xdfd13add4b8999b15a1fe7c8794abfee70b7238e"
  }
};

  Contract.checkNetwork = function(callback) {
    var self = this;

    if (this.network_id != null) {
      return callback();
    }

    this.web3.version.network(function(err, result) {
      if (err) return callback(err);

      var network_id = result.toString();

      // If we have the main network,
      if (network_id == "1") {
        var possible_ids = ["1", "live", "default"];

        for (var i = 0; i < possible_ids.length; i++) {
          var id = possible_ids[i];
          if (Contract.all_networks[id] != null) {
            network_id = id;
            break;
          }
        }
      }

      if (self.all_networks[network_id] == null) {
        return callback(new Error(self.name + " error: Can't find artifacts for network id '" + network_id + "'"));
      }

      self.setNetwork(network_id);
      callback();
    })
  };

  Contract.setNetwork = function(network_id) {
    var network = this.all_networks[network_id] || {};

    this.abi             = this.prototype.abi             = network.abi;
    this.unlinked_binary = this.prototype.unlinked_binary = network.unlinked_binary;
    this.address         = this.prototype.address         = network.address;
    this.updated_at      = this.prototype.updated_at      = network.updated_at;
    this.links           = this.prototype.links           = network.links || {};
    this.events          = this.prototype.events          = network.events || {};

    this.network_id = network_id;
  };

  Contract.networks = function() {
    return Object.keys(this.all_networks);
  };

  Contract.link = function(name, address) {
    if (typeof name == "function") {
      var contract = name;

      if (contract.address == null) {
        throw new Error("Cannot link contract without an address.");
      }

      Contract.link(contract.contract_name, contract.address);

      // Merge events so this contract knows about library's events
      Object.keys(contract.events).forEach(function(topic) {
        Contract.events[topic] = contract.events[topic];
      });

      return;
    }

    if (typeof name == "object") {
      var obj = name;
      Object.keys(obj).forEach(function(name) {
        var a = obj[name];
        Contract.link(name, a);
      });
      return;
    }

    Contract.links[name] = address;
  };

  Contract.contract_name   = Contract.prototype.contract_name   = "StructStorage";
  Contract.generated_with  = Contract.prototype.generated_with  = "3.2.0";

  // Allow people to opt-in to breaking changes now.
  Contract.next_gen = false;

  var properties = {
    binary: function() {
      var binary = Contract.unlinked_binary;

      Object.keys(Contract.links).forEach(function(library_name) {
        var library_address = Contract.links[library_name];
        var regex = new RegExp("__" + library_name + "_*", "g");

        binary = binary.replace(regex, library_address.replace("0x", ""));
      });

      return binary;
    }
  };

  Object.keys(properties).forEach(function(key) {
    var getter = properties[key];

    var definition = {};
    definition.enumerable = true;
    definition.configurable = false;
    definition.get = getter;

    Object.defineProperty(Contract, key, definition);
    Object.defineProperty(Contract.prototype, key, definition);
  });

  bootstrap(Contract);

  if (typeof module != "undefined" && typeof module.exports != "undefined") {
    module.exports = Contract;
  } else {
    // There will only be one version of this contract in the browser,
    // and we can use that.
    window.StructStorage = Contract;
  }
})();
