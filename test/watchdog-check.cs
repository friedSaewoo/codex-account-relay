using System;
using System.IO;
using System.Reflection;
using System.Collections.Generic;
class WatchdogCheck {
    static int Main(string[] args) {
        var method = Assembly.LoadFile(Path.GetFullPath(args[0])).GetType("RelayTray").GetMethod("ShouldRestartManager",BindingFlags.NonPublic|BindingFlags.Static);
        var now = new DateTime(2026,10,13,0,0,0,DateTimeKind.Utc); int pid=123;
        var empty=new Dictionary<string,object>();
        var stale=new Dictionary<string,object>{{"pid",pid},{"updated",now.AddMinutes(-5).ToString("o")}};
        var fresh=new Dictionary<string,object>{{"pid",pid},{"updated",now.AddSeconds(-2).ToString("o")}};
        var wrong=new Dictionary<string,object>{{"pid",456},{"updated",now.ToString("o")}};
        var draining=new Dictionary<string,object>{{"shuttingDown",true}};
        Func<Dictionary<string,object>,DateTime,DateTime,bool> restart=(s,started,healthy)=>(bool)method.Invoke(null,new object[]{s,pid,now,started,healthy});
        if(restart(empty,now.AddHours(-1),now.AddSeconds(-2))) return 1;
        if(restart(stale,now.AddHours(-1),now.AddSeconds(-2))) return 2;
        if(restart(wrong,now.AddHours(-1),now.AddSeconds(-2))) return 3;
        if(restart(fresh,now.AddHours(-1),now.AddMinutes(-5))) return 4;
        if(restart(empty,now.AddSeconds(-50),now.AddMinutes(-5))) return 5;
        if(!restart(empty,now.AddHours(-1),now.AddSeconds(-91))) return 6;
        if(!restart(stale,now.AddHours(-1),now.AddSeconds(-91))) return 7;
        if(restart(draining,now.AddHours(-1),now.AddMinutes(-5))) return 8;
        Console.WriteLine("Watchdog tolerates transient reads and still recovers a genuinely stale manager.");
        return 0;
    }
}
