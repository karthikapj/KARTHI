
contract StructStorage {

    uint256 public s = 1;
    uint256 public c;
    uint256 public t=1;
    mapping (address => uint) balances;

    function fundaddr(address addr) {
		balances[addr] = 2000;
	}

    	function sendCoin(address receiver, uint amount, address sender) returns(bool sufficient) {


		if (balances[sender] < amount)
		return false;

		balances[sender] -= amount;
		balances[receiver] += amount;


    	return true;

	}

    function getBalance(address addr) returns(uint) {
		return balances[addr];
	}
struct patient {

    bytes pid;
    bytes32 pname;
    bytes32 loc;
    bytes32 disease;
    uint256 contact;
    bytes32 doctor;
    uint rgprice;
}

struct test {

    bytes testno;
    bytes group;
    uint charge;
    bytes32 testdate;
    bytes32 result;
}

address public tester;

address owner;

mapping (bytes => patient) p1;
patient[] public fm;

mapping (bytes => test) t1;
test[] public l;



function produce(bytes id, bytes32 name, bytes32 loc, bytes32 cr, uint256 con, bytes32 q, uint pr) {

        var fnew = patient(id,name,loc,cr,con,q,pr);
        p1[id] = fnew;
        fm.push(fnew);
        s++;

}

 function getproduce(bytes j) constant returns(bytes,bytes32,bytes32,bytes32,uint256,bytes32,uint) {
        return (p1[j].pid,p1[j].pname,p1[j].loc,p1[j].disease,p1[j].contact,p1[j].doctor,p1[j].rgprice);
    }
 function test1(bytes ll, bytes g, uint p, bytes32 tt, bytes32 e) {

        var lnew=test(ll,g,p,tt,e);
        t1[ll]=lnew;
        l.push(lnew);
        t++;

 }
 function gettest(bytes k) constant returns(bytes,bytes,uint,bytes32,bytes32) {
     return(t1[k].testno,t1[k].group,t1[k].charge,t1[k].testdate,t1[k].result);

 }
}
