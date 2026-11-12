//+------------------------------------------------------------------+
//|                                                  ExportTicks.mq5 |
//|  Exports raw ticks of a symbol to a CSV file for the Tick Chart  |
//|  web app. Output goes to <Data Folder>\MQL5\Files\               |
//+------------------------------------------------------------------+
#property copyright   "Tick Chart"
#property version     "1.00"
#property description "Exports raw ticks (bid/ask/flags) to MQL5\\Files for the Tick Chart web app."
#property script_show_inputs

input int      InpDays        = 5;     // Trading days to export (including today)
input bool     InpAddPrevDay  = true;  // Also export the day before (needed for the first day's CPR)
input datetime InpFrom        = 0;     // OR: start date/time (server). 0 = use "Trading days"
input datetime InpTo          = 0;     // End date/time (server). 0 = now
input string   InpSymbol      = "";    // Symbol ("" = this chart's symbol)

//+------------------------------------------------------------------+
string DateTag(datetime t)
  {
   string s = TimeToString(t, TIME_DATE);   // 2026.11.12
   StringReplace(s, ".", "-");
   return s;
  }

//+------------------------------------------------------------------+
void OnStart()
  {
   string sym = (InpSymbol == "") ? _Symbol : InpSymbol;
   if(!SymbolSelect(sym, true))
     {
      Alert("ExportTicks: unknown symbol ", sym);
      return;
     }

   datetime to = (InpTo == 0) ? TimeTradeServer() : InpTo;
   datetime from = InpFrom;
   if(from == 0)
     {
      int shift = MathMax(0, InpDays - 1) + (InpAddPrevDay ? 1 : 0);
      from = iTime(sym, PERIOD_D1, shift);            // start of that daily bar (server time)
      if(from == 0)                                    // daily history not loaded: fall back to calendar days
        {
         MqlDateTime dt;
         TimeToStruct(to, dt);
         dt.hour = 0; dt.min = 0; dt.sec = 0;
         from = StructToTime(dt) - (datetime)(shift * 86400);
        }
     }
   if(from >= to)
     {
      Alert("ExportTicks: start must be before end");
      return;
     }

   int    digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double point  = SymbolInfoDouble(sym, SYMBOL_POINT);
   string fname  = StringFormat("%s_ticks_%s_to_%s.csv", sym, DateTag(from), DateTag(to));

   int h = FileOpen(fname, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE)
     {
      Alert("ExportTicks: cannot create file ", fname, " error ", GetLastError());
      return;
     }
   FileWriteString(h, StringFormat("#symbol=%s,digits=%d,point=%s,from=%s,to=%s\n",
                                   sym, digits, DoubleToString(point, digits),
                                   TimeToString(from, TIME_DATE | TIME_SECONDS),
                                   TimeToString(to, TIME_DATE | TIME_SECONDS)));
   FileWriteString(h, "time_msc,bid,ask,last,volume,flags\n");

   const long DAY_MS = 86400000;
   long from_msc = (long)from * 1000;
   long to_msc   = (long)to * 1000 + 999;
   long total    = 0;
   MqlTick ticks[];

   // Copy one day at a time to keep memory use low.
   for(long cs = from_msc; cs <= to_msc && !IsStopped(); cs += DAY_MS)
     {
      long ce = MathMin(cs + DAY_MS - 1, to_msc);
      int n = -1;
      for(int attempt = 0; attempt < 15 && !IsStopped(); attempt++)
        {
         ResetLastError();
         n = CopyTicksRange(sym, ticks, COPY_TICKS_ALL, (ulong)cs, (ulong)ce);
         if(n >= 0)
            break;
         Sleep(400);                                    // history still downloading from the server
        }
      if(n < 0)
        {
         Print("ExportTicks: could not get ticks for ", TimeToString((datetime)(cs / 1000)), " error ", GetLastError());
         continue;
        }

      for(int i = 0; i < n; i++)
        {
         FileWriteString(h, IntegerToString(ticks[i].time_msc) + "," +
                         DoubleToString(ticks[i].bid, digits) + "," +
                         DoubleToString(ticks[i].ask, digits) + "," +
                         DoubleToString(ticks[i].last, digits) + "," +
                         IntegerToString((long)ticks[i].volume) + "," +
                         IntegerToString((long)ticks[i].flags) + "\n");
        }
      total += n;
      Comment(StringFormat("ExportTicks %s: %s  (%I64d ticks)", sym, TimeToString((datetime)(cs / 1000), TIME_DATE), total));
     }

   FileClose(h);
   Comment("");
   string path = TerminalInfoString(TERMINAL_DATA_PATH) + "\\MQL5\\Files\\" + fname;
   Print("ExportTicks: wrote ", total, " ticks to ", path);
   Alert(StringFormat("ExportTicks: %I64d ticks of %s saved to\n%s", total, sym, path));
  }
//+------------------------------------------------------------------+
